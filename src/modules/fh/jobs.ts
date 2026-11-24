// Feedback Hub background jobs (§3.9): duplicate matching (FH-406, D-05) and nightly reconciliation (§4.11, INV-18).
import { sql } from 'kysely';
import { getDb } from '@/server/db';
import { registerJob } from '@/modules/core/service';
import type { Db } from './store';
import { refreshReporting } from './reporting';
import './register';

/**
 * FH-406: source terms are the stemmed words of the title; candidates are live ideas whose stored, indexed
 * search vector matches any term; score = share of terms found in the candidate's title and description.
 * Keep score ≥ 0.5, ranked by score, then title hits, then newest; store the top 10. Two statements.
 */
export async function computeMatches(db: Db, ideaId: string): Promise<number> {
  await sql`DELETE FROM fh_idea_match WHERE idea_id = ${ideaId}::uuid`.execute(db);
  const res = await sql`
    WITH src AS (SELECT to_tsvector('english', title) AS tv FROM fh_idea WHERE id = ${ideaId}::uuid AND merged_into_id IS NULL),
    terms AS (SELECT DISTINCT u.lexeme FROM src, unnest(src.tv) u),
    total AS (SELECT count(*)::int AS n FROM terms),
    q AS (SELECT string_agg(quote_literal(lexeme), ' | ')::tsquery AS tq FROM terms),
    cand AS (
      SELECT c.id, c.updated_at,
        (SELECT count(*) FROM terms t WHERE c.search_tsv @@ quote_literal(t.lexeme)::tsquery)::int AS hits,
        (SELECT count(*) FROM terms t WHERE c.search_tsv @@ (quote_literal(t.lexeme) || ':A')::tsquery)::int AS title_hits
      FROM fh_idea c, q
      WHERE q.tq IS NOT NULL AND c.merged_into_id IS NULL AND c.id <> ${ideaId}::uuid AND c.search_tsv @@ q.tq),
    top AS (
      SELECT id, (hits::real / (SELECT n FROM total)) AS score, title_hits, updated_at FROM cand
      WHERE hits::real / (SELECT n FROM total) >= 0.5
      ORDER BY score DESC, title_hits DESC, updated_at DESC LIMIT 10)
    INSERT INTO fh_idea_match (idea_id, candidate_id, score, title_hits, computed_at)
    SELECT ${ideaId}::uuid, id, LEAST(1, score), title_hits, now() FROM top`.execute(db);
  return Number(res.numAffectedRows ?? 0);
}

export interface ReconcileReport { rollupDrift: number; demandDrift: number; closureDrift: number }

/**
 * Recomputes every derived table from its inputs, repairs differences and reports how many rows drifted
 * (INV-09, INV-18). A non-zero report raises an alert in the logs.
 */
export async function reconcile(db: Db = getDb(), repair = true): Promise<ReconcileReport> {
  const rollup = await sql<{ id: string }>`
    WITH fresh AS (SELECT * FROM fh_rollup_compute(ARRAY(SELECT id FROM fh_idea WHERE merged_into_id IS NULL)))
    SELECT f.idea_id::text AS id FROM fresh f LEFT JOIN fh_idea_rollup r ON r.idea_id = f.idea_id
    WHERE r.idea_id IS NULL
       OR (r.user_count, r.company_count, r.arr, r.insight_count, r.vote_total, r.distinct_voters, r.sources,
           r.has_intake_source, r.on_forum, r.external_intake)
          IS DISTINCT FROM
          (f.user_count, f.company_count, f.arr, f.insight_count, f.vote_total, f.distinct_voters, f.sources,
           f.has_intake_source, f.on_forum, f.external_intake)`.execute(db);
  const demand = await sql<{ id: string; open_count: number; all_count: number }>`
    WITH fresh AS (
      SELECT f.id, (count(i.id) FILTER (WHERE fh_is_open(i.status, i.bug_status)))::int AS open_count, count(i.id)::int AS all_count
      FROM fh_feature f LEFT JOIN fh_idea i ON i.feature_id = f.id AND i.merged_into_id IS NULL GROUP BY f.id)
    SELECT fresh.id::text, fresh.open_count, fresh.all_count FROM fresh LEFT JOIN fh_feature_demand d ON d.feature_id = fresh.id
    WHERE d.feature_id IS NULL OR d.open_count <> fresh.open_count OR d.all_count <> fresh.all_count`.execute(db);
  const closure = await sql<{ n: number }>`
    WITH RECURSIVE tree AS (
      SELECT id AS ancestor_id, id AS descendant_id, 0 AS distance FROM fh_feature
      UNION ALL
      SELECT t.ancestor_id, f.id, t.distance + 1 FROM tree t JOIN fh_feature f ON f.parent_id = t.descendant_id),
    diff AS (
      (SELECT ancestor_id, descendant_id, distance::smallint FROM tree EXCEPT SELECT ancestor_id, descendant_id, distance FROM fh_feature_closure)
      UNION ALL
      (SELECT ancestor_id, descendant_id, distance FROM fh_feature_closure EXCEPT SELECT ancestor_id, descendant_id, distance::smallint FROM tree))
    SELECT count(*)::int AS n FROM diff`.execute(db);
  const report = { rollupDrift: rollup.rows.length, demandDrift: demand.rows.length, closureDrift: closure.rows[0].n };

  if (repair) {
    if (report.rollupDrift) await sql`SELECT fh_rollup_refresh(${rollup.rows.map((r) => r.id)}::uuid[])`.execute(db);
    if (report.demandDrift) {
      await sql`
        INSERT INTO fh_feature_demand (feature_id, open_count, all_count)
        SELECT (x->>'id')::uuid, (x->>'open_count')::int, (x->>'all_count')::int FROM jsonb_array_elements(${JSON.stringify(demand.rows)}::jsonb) x
        ON CONFLICT (feature_id) DO UPDATE SET open_count = EXCLUDED.open_count, all_count = EXCLUDED.all_count, updated_at = now()`.execute(db);
    }
    if (report.closureDrift) {
      await sql`DELETE FROM fh_feature_closure`.execute(db);
      await sql`
        INSERT INTO fh_feature_closure (ancestor_id, descendant_id, distance)
        WITH RECURSIVE tree AS (
          SELECT id AS ancestor_id, id AS descendant_id, 0 AS distance FROM fh_feature
          UNION ALL SELECT t.ancestor_id, f.id, t.distance + 1 FROM tree t JOIN fh_feature f ON f.parent_id = t.descendant_id)
        SELECT ancestor_id, descendant_id, distance FROM tree`.execute(db);
    }
  }
  if (report.rollupDrift || report.demandDrift || report.closureDrift) {
    console.error(JSON.stringify({ level: 'alert', msg: 'fh reconciliation found drift', ...report }));
  }
  return report;
}

registerJob('fh.match.compute', async (payload) => {
  if (typeof payload.ideaId === 'string') await computeMatches(getDb(), payload.ideaId);
});
registerJob('fh.reconcile', async () => { await reconcile(); });
// FH-505: roll-ups for more than 500 affected ideas (a company's ARR or domain, a person's company).
registerJob('fh.rollup.refresh', async (payload) => {
  const ids = Array.isArray(payload.ideaIds) ? payload.ideaIds.filter((x): x is string => typeof x === 'string') : [];
  for (let i = 0; i < ids.length; i += 1000) {
    await sql`SELECT fh_rollup_refresh(${ids.slice(i, i + 1000)}::uuid[])`.execute(getDb());
  }
});
// FH-854: reporting materialised view, every 5 minutes (pg_cron enqueues it; db/supabase/setup.sql).
registerJob('fh.reporting.refresh', async () => { await refreshReporting(); });
