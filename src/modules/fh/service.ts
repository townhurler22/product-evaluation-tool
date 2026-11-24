// Feedback Hub's public service interface (§11.4, ARC-01, ARC-02, ARC-17 to ARC-21). Sets in, maps out; each
// method states its statement count and a PGlite test holds it there (PT-16). Feedback Hub owns the demand rules
// and implements them once, here (INT-10 to INT-14, D-19, D-29): Journey Boards never recounts.
import { sql } from 'kysely';
import type {
  AssignResult, Breakdown, DemandResult, DemandScope, EnsureJourneyResult, FeatureRef, IdeaRef, JourneyRef, Unavailable,
} from '@pet/contracts';
import type { Principal } from '@/modules/core/service';
import { getDb } from '@/server/db';
import { isUuid } from './columns';

export const DEMAND_CAPS = { sets: 5_000, idsPerSet: 2_000 } as const; // INT-47
const UNAVAILABLE: Unavailable = { available: false };
const j = (v: unknown) => JSON.stringify(v);

/** ARC-19: every active staff member may read Feedback Hub (members read; feedback admins change data). */
export function hasAccess(viewer: Principal | null): viewer is Principal { return Boolean(viewer); }

const uuids = (xs: Iterable<string>, cap = 2_000) => [...new Set([...xs].filter(isUuid).map((x) => x.toLowerCase()))].slice(0, cap);
const uuidArray = (xs: string[]) => sql`ARRAY(SELECT jsonb_array_elements_text(${j(xs)}::jsonb))::uuid[]`;

// A Feature as other modules see it: name, depth, ancestor path and counts including sub-features.
const featureJson = sql`json_build_object('id', f.id, 'name', f.name, 'depth', f.depth,
  'path', coalesce((SELECT json_agg(a.name ORDER BY c.distance DESC) FROM fh_feature_closure c JOIN fh_feature a ON a.id = c.ancestor_id
                    WHERE c.descendant_id = f.id AND c.distance > 0), '[]'::json),
  'openCount', (SELECT coalesce(sum(d.open_count), 0)::int FROM fh_feature_closure c JOIN fh_feature_demand d ON d.feature_id = c.descendant_id WHERE c.ancestor_id = f.id),
  'allCount', (SELECT coalesce(sum(d.all_count), 0)::int FROM fh_feature_closure c JOIN fh_feature_demand d ON d.feature_id = c.descendant_id WHERE c.ancestor_id = f.id))`;
const journeyJson = sql`json_build_object('id', jr.id, 'name', jr.name, 'syncedAt', jr.synced_at, 'syncedByName', coalesce(u.full_name, u.email))`;

/**
 * demandForSets (PERF-30 step 3, INT-10 to INT-13, INT-39): for every set, expand Features through the closure,
 * de-duplicate, sum the maintained per-Feature counts, take the latest due date of open in-flight ideas, and name
 * missing Features as gone. Optionally reports gone Journeys and describes Features and Journeys for the panel.
 * ONE statement whatever the number of sets (D-18, D-19). Caps: 5,000 sets, 2,000 ids per set.
 */
export async function demandForSets(viewer: Principal | null, input: {
  sets: Record<string, string[]>; scope: DemandScope; journeyIds?: string[]; describe?: boolean;
}): Promise<DemandResult | Unavailable> {
  if (!hasAccess(viewer)) return UNAVAILABLE;
  const keys = Object.keys(input.sets).slice(0, DEMAND_CAPS.sets);
  if (!keys.length && !input.journeyIds?.length) return { available: true, bySet: {}, goneJourneyIds: [], features: {}, journeys: {} };
  // Ids that are not even uuids can never exist: they are gone without asking the database (ARC-20).
  const clean: Record<string, string[]> = {};
  const badIds: Record<string, string[]> = {};
  for (const k of keys) {
    const ids = [...new Set(input.sets[k])].slice(0, DEMAND_CAPS.idsPerSet);
    clean[k] = ids.filter(isUuid).map((x) => x.toLowerCase());
    const bad = ids.filter((x) => !isUuid(x));
    if (bad.length) badIds[k] = bad;
  }
  const journeyIds = uuids(input.journeyIds ?? []);
  const { rows } = await sql<{ by_set: Record<string, { count: number; targetDate: string | null; goneFeatureIds: string[] }>; gone_journeys: string[]; features: Record<string, FeatureRef> | null; journeys: Record<string, JourneyRef> | null }>`
    WITH input AS (
      SELECT s.key, e.v::uuid AS fid FROM jsonb_each(${j(clean)}::jsonb) s, jsonb_array_elements_text(s.value) e(v)),
    present AS (SELECT DISTINCT i.key, i.fid FROM input i JOIN fh_feature f ON f.id = i.fid),
    gone AS (SELECT i.key, json_agg(DISTINCT i.fid) AS ids FROM input i
             WHERE NOT EXISTS (SELECT 1 FROM fh_feature f WHERE f.id = i.fid) GROUP BY i.key),
    expanded AS (SELECT DISTINCT p.key, c.descendant_id AS fid FROM present p JOIN fh_feature_closure c ON c.ancestor_id = p.fid),
    counts AS (SELECT e.key, sum(${input.scope === 'all' ? sql`d.all_count` : sql`d.open_count`})::int AS n
               FROM expanded e JOIN fh_feature_demand d ON d.feature_id = e.fid GROUP BY e.key),
    dates AS (SELECT e.key, max(i.due_date)::text AS d FROM expanded e
              JOIN fh_idea i ON i.feature_id = e.fid AND i.merged_into_id IS NULL AND (i.status IN ('PLANNED','IN_PROGRESS') OR i.bug_status = 'IN_DEV')
              GROUP BY e.key)
    SELECT
      coalesce((SELECT json_object_agg(k.key, json_build_object('count', coalesce(c.n, 0), 'targetDate', d.d, 'goneFeatureIds', coalesce(g.ids, '[]'::json)))
        FROM jsonb_object_keys(${j(clean)}::jsonb) k(key) LEFT JOIN counts c ON c.key = k.key LEFT JOIN dates d ON d.key = k.key LEFT JOIN gone g ON g.key = k.key), '{}'::json) AS by_set,
      coalesce((SELECT json_agg(x) FROM unnest(${uuidArray(journeyIds)}) x WHERE NOT EXISTS (SELECT 1 FROM fh_journey jr WHERE jr.id = x)), '[]'::json) AS gone_journeys,
      ${input.describe ? sql`(SELECT json_object_agg(f.id, ${featureJson}) FROM fh_feature f WHERE f.id IN (SELECT fid FROM present))` : sql`NULL::json`} AS features,
      (SELECT json_object_agg(jr.id, ${journeyJson}) FROM fh_journey jr LEFT JOIN core_user u ON u.id = jr.synced_by WHERE jr.id = ANY(${uuidArray(journeyIds)})) AS journeys`
    .execute(getDb());
  const r = rows[0];
  const bySet = r.by_set;
  for (const [k, bad] of Object.entries(badIds)) bySet[k] = { ...bySet[k], goneFeatureIds: [...(bySet[k]?.goneFeatureIds ?? []), ...bad] };
  return { available: true, bySet, goneJourneyIds: r.gone_journeys, features: r.features ?? {}, journeys: r.journeys ?? {} };
}

/** INT-39 on its own. 1 statement (through demandForSets). */
export async function targetDatesForSets(viewer: Principal | null, input: { sets: Record<string, string[]> }): Promise<Record<string, string | null> | Unavailable> {
  const r = await demandForSets(viewer, { sets: input.sets, scope: 'open' });
  if (!r.available) return r;
  return Object.fromEntries(Object.entries(r.bySet).map(([k, v]) => [k, v.targetDate]));
}

const scopeFilter = (scope: DemandScope) => (scope === 'all' ? sql`true` : sql`fh_is_open(i.status, i.bug_status)`);

/**
 * INT-40: distinct live ideas under the Features and their sub-features, most recently updated first, ties by title.
 * ONE statement (the total and the page together). Caps: 2,000 Feature ids, 50 rows.
 */
export async function ideasUnder(viewer: Principal | null, input: { featureIds: string[]; scope: DemandScope; limit?: number; cursor?: string | null }): Promise<{ available: true; total: number; ideas: IdeaRef[]; nextCursor: string | null } | Unavailable> {
  if (!hasAccess(viewer)) return UNAVAILABLE;
  const ids = uuids(input.featureIds);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const offset = Math.max(0, Number.parseInt(input.cursor ?? '0', 10) || 0);
  if (!ids.length) return { available: true, total: 0, ideas: [], nextCursor: null };
  const { rows } = await sql<{ total: number; ideas: IdeaRef[] }>`
    WITH f AS (SELECT DISTINCT c.descendant_id AS id FROM fh_feature_closure c WHERE c.ancestor_id = ANY(${uuidArray(ids)})),
    m AS (SELECT i.id, i.number, i.title, i.idea_type, i.status, i.bug_status, i.due_date, i.updated_at FROM fh_idea i
          WHERE i.feature_id IN (SELECT id FROM f) AND i.merged_into_id IS NULL AND ${scopeFilter(input.scope)})
    SELECT (SELECT count(*) FROM m)::int AS total,
      coalesce((SELECT json_agg(json_build_object('id', p.id, 'number', p.number, 'title', p.title, 'ideaType', p.idea_type, 'status', p.status,
        'bugStatus', p.bug_status, 'dueDate', p.due_date::text, 'updatedAt', p.updated_at) ORDER BY p.updated_at DESC, p.title, p.id)
        FROM (SELECT * FROM m ORDER BY updated_at DESC, title, id OFFSET ${offset} LIMIT ${limit}) p), '[]'::json) AS ideas`.execute(getDb());
  const { total, ideas } = rows[0];
  return { available: true, total, ideas, nextCursor: offset + ideas.length < total ? String(offset + ideas.length) : null };
}

/**
 * INT-41: total, counts by type and by status (bug status for bugs, keyed `bug:<status>`), distinct companies and the
 * top 5 companies by ARR (decimal string; no ARR last; ties by ideas then name). ONE statement. Cap: 2,000 ids.
 */
export async function breakdown(viewer: Principal | null, input: { featureIds: string[]; scope: DemandScope }): Promise<({ available: true } & Breakdown) | Unavailable> {
  if (!hasAccess(viewer)) return UNAVAILABLE;
  const ids = uuids(input.featureIds);
  if (!ids.length) return { available: true, total: 0, byType: {}, byStatus: {}, companyCount: 0, topCompanies: [] };
  const { rows } = await sql<Breakdown>`
    WITH f AS (SELECT DISTINCT c.descendant_id AS id FROM fh_feature_closure c WHERE c.ancestor_id = ANY(${uuidArray(ids)})),
    m AS (SELECT i.id, i.idea_type, CASE WHEN i.idea_type = 'BUG' THEN 'bug:' || i.bug_status ELSE i.status END AS st FROM fh_idea i
          WHERE i.feature_id IN (SELECT id FROM f) AND i.merged_into_id IS NULL AND ${scopeFilter(input.scope)}),
    co AS (SELECT ic.company_id, count(DISTINCT ic.idea_id)::int AS n FROM fh_idea_company ic WHERE ic.idea_id IN (SELECT id FROM m) GROUP BY 1)
    SELECT (SELECT count(*) FROM m)::int AS total,
      coalesce((SELECT json_object_agg(t.idea_type, t.n) FROM (SELECT idea_type, count(*)::int AS n FROM m GROUP BY 1) t), '{}'::json) AS "byType",
      coalesce((SELECT json_object_agg(t.st, t.n) FROM (SELECT st, count(*)::int AS n FROM m GROUP BY 1) t), '{}'::json) AS "byStatus",
      (SELECT count(*) FROM co)::int AS "companyCount",
      coalesce((SELECT json_agg(t) FROM (SELECT c.id, c.name, c.arr::text AS arr, co.n AS "ideaCount" FROM co JOIN core_company c ON c.id = co.company_id
        ORDER BY c.arr DESC NULLS LAST, co.n DESC, c.name LIMIT 5) t), '[]'::json) AS "topCompanies"`.execute(getDb());
  return { available: true, ...rows[0] };
}

/** INT-43 Feature search: from the 3rd character, ≤ 20 results in tree order with depth and path. ONE statement. */
export async function searchFeatures(viewer: Principal | null, input: { query: string; limit?: number }): Promise<{ available: true; features: FeatureRef[] } | Unavailable> {
  if (!hasAccess(viewer)) return UNAVAILABLE;
  const q = input.query.trim().slice(0, 100);
  if (q.length < 3) return { available: true, features: [] };
  const term = `%${q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
  const { rows } = await sql<{ f: FeatureRef }>`
    SELECT ${featureJson} AS f FROM fh_feature f
    WHERE lower(f.name) LIKE ${term}
    ORDER BY (SELECT string_agg(lpad(a.sort_order::text, 6, '0') || lower(a.name), '/' ORDER BY c.distance DESC)
              FROM fh_feature_closure c JOIN fh_feature a ON a.id = c.ancestor_id WHERE c.descendant_id = f.id)
    LIMIT ${Math.min(input.limit ?? 20, 20)}`.execute(getDb());
  return { available: true, features: rows.map((r) => r.f) };
}

/** ARC-20: id → FeatureRef or "gone". ONE statement. Cap: 2,000 ids. */
export async function resolveFeatures(viewer: Principal | null, ids: string[]): Promise<Record<string, FeatureRef | 'gone'> | Unavailable> {
  if (!hasAccess(viewer)) return UNAVAILABLE;
  const all = [...new Set(ids)].slice(0, 2_000);
  const out: Record<string, FeatureRef | 'gone'> = Object.fromEntries(all.map((i) => [i, 'gone' as const]));
  const valid = uuids(all);
  if (!valid.length) return out;
  const { rows } = await sql<{ f: FeatureRef }>`SELECT ${featureJson} AS f FROM fh_feature f WHERE f.id = ANY(${uuidArray(valid)})`.execute(getDb());
  for (const r of rows) out[r.f.id] = r.f;
  return out;
}

/** ARC-20: id → JourneyRef or "gone". ONE statement. Cap: 2,000 ids. */
export async function resolveJourneys(viewer: Principal | null, ids: string[]): Promise<Record<string, JourneyRef | 'gone'> | Unavailable> {
  if (!hasAccess(viewer)) return UNAVAILABLE;
  const all = [...new Set(ids)].slice(0, 2_000);
  const out: Record<string, JourneyRef | 'gone'> = Object.fromEntries(all.map((i) => [i, 'gone' as const]));
  const valid = uuids(all);
  if (!valid.length) return out;
  const { rows } = await sql<{ r: JourneyRef }>`SELECT ${journeyJson} AS r FROM fh_journey jr LEFT JOIN core_user u ON u.id = jr.synced_by
    WHERE jr.id = ANY(${uuidArray(valid)})`.execute(getDb());
  for (const r of rows) out[r.r.id] = r.r;
  return out;
}

/** For jb.demand.notify: each Feature's ancestors (closure, distance > 0). ONE statement. Cap: 2,000 ids. */
export async function featureAncestors(featureIds: string[]): Promise<Record<string, string[]>> {
  const ids = uuids(featureIds);
  if (!ids.length) return {};
  const { rows } = await sql<{ id: string; a: string[] }>`SELECT descendant_id AS id, array_agg(ancestor_id::text) AS a FROM fh_feature_closure
    WHERE descendant_id = ANY(${uuidArray(ids)}) AND distance > 0 GROUP BY 1`.execute(getDb());
  return Object.fromEntries(rows.map((r) => [r.id, r.a]));
}

/**
 * For jb.demand.notify (PERF-31): the Features and Journeys whose demand inputs changed since the last call, as marked
 * by the 0006 triggers. `ack` clears exactly what was read (later marks survive). 1 statement each.
 */
export async function pendingDemandChanges(limit = 2_000): Promise<{ featureIds: string[]; journeyIds: string[]; ack: () => Promise<void> }> {
  const { rows } = await sql<{ kind: 'feature' | 'journey'; id: string; changed_at: Date }>`
    SELECT kind, id::text, changed_at FROM fh_demand_dirty ORDER BY changed_at LIMIT ${limit}`.execute(getDb());
  return {
    featureIds: rows.filter((r) => r.kind === 'feature').map((r) => r.id),
    journeyIds: rows.filter((r) => r.kind === 'journey').map((r) => r.id),
    ack: async () => {
      if (!rows.length) return;
      await sql`DELETE FROM fh_demand_dirty d USING jsonb_to_recordset(${j(rows)}::jsonb) AS x(kind text, id uuid, changed_at timestamptz)
        WHERE d.kind = x.kind AND d.id = x.id AND d.changed_at <= x.changed_at`.execute(getDb());
    },
  };
}

const uniqueViolation = (e: unknown) => (e as { code?: string }).code === '23505' || /duplicate key|unique/i.test(String((e as Error)?.message));

/**
 * INT-16 find, create or rename. Same name ignoring case and outer spaces → found (renamed when it is the card's own
 * Journey spelled differently); else rename `renameId`; else create. A concurrent create that hits the unique
 * name_key (INV-23) re-reads and returns found. ≤ 4 statements.
 */
export async function ensureJourneyComponent(viewer: Principal | null, input: { name: string; renameId?: string | null }): Promise<EnsureJourneyResult | Unavailable> {
  if (!hasAccess(viewer)) return UNAVAILABLE;
  const name = input.name.trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!name) throw new Error('ensureJourneyComponent needs a name');
  const renameId = input.renameId && isUuid(input.renameId) ? input.renameId.toLowerCase() : null;
  const db = getDb();
  const read = async () => (await sql<{ id: string; name: string; synced_at: Date | null; synced_by_name: string | null; same: boolean }>`
    SELECT jr.id::text, jr.name, jr.synced_at, coalesce(u.full_name, u.email) AS synced_by_name, jr.name_key = lower(btrim(${name})) AS same
    FROM fh_journey jr LEFT JOIN core_user u ON u.id = jr.synced_by
    WHERE jr.name_key = lower(btrim(${name})) OR jr.id = ${renameId}::uuid`.execute(db)).rows;
  const ref = (r: { id: string; name: string; synced_at: Date | null; synced_by_name: string | null }): JourneyRef =>
    ({ id: r.id, name: r.name, syncedAt: r.synced_at ? new Date(r.synced_at).toISOString() : null, syncedByName: r.synced_by_name });
  const rename = async (id: string) => {
    const u = await sql<{ id: string; name: string; synced_at: Date | null }>`UPDATE fh_journey SET name = ${name} WHERE id = ${id}::uuid
      RETURNING id::text, name, synced_at`.execute(db);
    return u.rows[0];
  };

  const rows = await read();
  const same = rows.find((r) => r.same);
  if (same) {
    if (same.id === renameId && same.name !== name) {
      const u = await rename(same.id);
      return { journey: ref({ ...u, synced_by_name: same.synced_by_name }), outcome: 'renamed' };
    }
    return { journey: ref(same), outcome: 'found' };
  }
  const own = rows.find((r) => r.id === renameId);
  try {
    if (own) {
      const u = await rename(own.id);
      return { journey: ref({ ...u, synced_by_name: own.synced_by_name }), outcome: 'renamed' };
    }
    const id = crypto.randomUUID();
    const ins = await sql<{ id: string; name: string }>`INSERT INTO fh_journey (id, name) VALUES (${id}::uuid, ${name})
      ON CONFLICT (name_key) DO NOTHING RETURNING id::text, name`.execute(db);
    if (ins.rows[0]) return { journey: ref({ ...ins.rows[0], synced_at: null, synced_by_name: null }), outcome: 'created' };
  } catch (e) {
    if (!uniqueViolation(e)) throw e;
  }
  const again = (await read()).find((r) => r.same);
  if (!again) throw new Error('journey vanished during ensure');
  return { journey: ref(again), outcome: 'found' };
}

/**
 * INT-19: set each Journey's memberships to every live idea at any status under its Features and their sub-features,
 * writing only the difference, and stamp synced_at / synced_by. Batched over Journeys (INT-20). Idempotent.
 * ONE statement (data-modifying CTEs) whatever the number of Journeys. Cap: 2,000 Feature ids per Journey.
 */
export async function assignJourneyIdeas(viewer: Principal | null, input: { assignments: { journeyId: string; featureIds: string[] }[] }): Promise<Record<string, AssignResult | 'gone'> | Unavailable> {
  if (!hasAccess(viewer)) return UNAVAILABLE;
  const list = input.assignments.filter((a) => isUuid(a.journeyId)).map((a) => ({ journeyId: a.journeyId.toLowerCase(), featureIds: uuids(a.featureIds) }));
  const out: Record<string, AssignResult | 'gone'> = Object.fromEntries(input.assignments.map((a) => [a.journeyId, 'gone' as const]));
  if (!list.length) return out;
  const { rows } = await sql<{ jid: string; total: number; added: number; removed: number; synced_at: Date }>`
    WITH a AS (SELECT (x->>'journeyId')::uuid AS jid, x->'featureIds' AS fids FROM jsonb_array_elements(${j(list)}::jsonb) x),
    jr AS (SELECT a.jid, a.fids FROM a JOIN fh_journey j ON j.id = a.jid),
    af AS (SELECT DISTINCT jr.jid, c.descendant_id AS fid FROM jr, jsonb_array_elements_text(jr.fids) e(v)
           JOIN fh_feature_closure c ON c.ancestor_id = e.v::uuid),
    want AS (SELECT DISTINCT af.jid, i.id AS idea_id FROM af JOIN fh_idea i ON i.feature_id = af.fid AND i.merged_into_id IS NULL),
    del AS (DELETE FROM fh_idea_journey ij USING jr WHERE ij.journey_id = jr.jid
            AND NOT EXISTS (SELECT 1 FROM want w WHERE w.jid = ij.journey_id AND w.idea_id = ij.idea_id) RETURNING ij.journey_id),
    ins AS (INSERT INTO fh_idea_journey (idea_id, journey_id) SELECT idea_id, jid FROM want ON CONFLICT DO NOTHING RETURNING journey_id),
    upd AS (UPDATE fh_journey SET synced_at = now(), synced_by = ${viewer.userId}::uuid WHERE id IN (SELECT jid FROM jr) RETURNING id, synced_at)
    SELECT upd.id::text AS jid, upd.synced_at,
      (SELECT count(*) FROM want w WHERE w.jid = upd.id)::int AS total,
      (SELECT count(*) FROM ins WHERE ins.journey_id = upd.id)::int AS added,
      (SELECT count(*) FROM del WHERE del.journey_id = upd.id)::int AS removed
    FROM upd`.execute(getDb());
  for (const r of rows) {
    const key = input.assignments.find((a) => a.journeyId.toLowerCase() === r.jid)?.journeyId ?? r.jid;
    out[key] = { total: r.total, added: r.added, removed: r.removed, syncedAt: new Date(r.synced_at).toISOString() };
  }
  return out;
}
