// The list-row shape (§4.4 step 2): one shape for the list, mutation responses and realtime events (PERF-01).
import { sql, type RawBuilder } from 'kysely';
import type { BugStatus, IdeaStatus, IdeaType } from './domain';
import type { Db } from './store';

export interface IdeaRow {
  id: string;
  number: number;
  title: string;
  ideaType: IdeaType;
  status: IdeaStatus | null;
  bugStatus: BugStatus | null;
  featureId: string | null;
  milestoneId: string | null;
  ownerId: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimateDays: number | null;
  strategicValue: number | null;
  revenueImpact: number | null;
  customerExperience: number | null;
  riskScore: number | null;
  effortScore: number | null;
  isDealbreaker: boolean;
  isCommitted: boolean;
  unreviewed: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  userCount: number;
  companyCount: number;
  /** numeric(14,2) as a string (FH-506). */
  arr: string;
  insightCount: number;
  voteTotal: number;
  distinctVoters: number;
  /** Derived from insights via the roll-up (D-07); empty reads as Manual. */
  sources: string[];
  hasIntakeSource: boolean;
  onForum: boolean;
  /** FH-405: an external intake source (internal calls excluded) and no company in the roll-up. */
  companyMissing: boolean;
  themeIds: string[];
  journeyIds: string[];
  companies: { id: string; name: string }[];
  /** Top stored duplicate suggestion (FH-406), merged candidates filtered at read time. */
  topMatch: { id: string; score: number } | null;
}

/** Columns of the list row for ideas aliased `i` joined to roll-up `r`. Aggregates read only the given ideas. */
export const ROW_COLUMNS = sql`
  i.id, i.number::int AS "number", i.title, i.idea_type AS "ideaType", i.status, i.bug_status AS "bugStatus",
  i.feature_id AS "featureId", i.milestone_id AS "milestoneId", i.owner_id AS "ownerId",
  i.start_date::text AS "startDate", i.due_date::text AS "dueDate", i.estimate_days AS "estimateDays",
  i.strategic_value AS "strategicValue", i.revenue_impact AS "revenueImpact",
  i.customer_experience AS "customerExperience", i.risk_score AS "riskScore", i.effort_score AS "effortScore",
  i.is_dealbreaker AS "isDealbreaker", i.is_committed AS "isCommitted", (i.reviewed_at IS NULL) AS unreviewed,
  i.version, i.created_at AS "createdAt", i.updated_at AS "updatedAt",
  COALESCE(r.user_count, 0) AS "userCount", COALESCE(r.company_count, 0) AS "companyCount",
  COALESCE(r.arr, 0)::text AS arr, COALESCE(r.insight_count, 0) AS "insightCount",
  COALESCE(r.vote_total, 0) AS "voteTotal", COALESCE(r.distinct_voters, 0) AS "distinctVoters",
  COALESCE(r.sources, '{}') AS sources, COALESCE(r.has_intake_source, false) AS "hasIntakeSource",
  COALESCE(r.on_forum, false) AS "onForum",
  (COALESCE(r.external_intake, false) AND COALESCE(r.company_count, 0) = 0) AS "companyMissing",
  ARRAY(SELECT t.theme_id::text FROM fh_idea_theme t WHERE t.idea_id = i.id ORDER BY t.theme_id) AS "themeIds",
  ARRAY(SELECT j.journey_id::text FROM fh_idea_journey j WHERE j.idea_id = i.id ORDER BY j.journey_id) AS "journeyIds",
  COALESCE((SELECT json_agg(json_build_object('id', c.id, 'name', c.name) ORDER BY c.name_key)
              FROM fh_idea_company ic JOIN core_company c ON c.id = ic.company_id WHERE ic.idea_id = i.id), '[]') AS companies,
  (SELECT json_build_object('id', m.candidate_id, 'score', round(m.score::numeric, 2))
     FROM fh_idea_match m JOIN fh_idea cand ON cand.id = m.candidate_id AND cand.merged_into_id IS NULL
    WHERE m.idea_id = i.id ORDER BY m.score DESC, m.title_hits DESC, cand.updated_at DESC LIMIT 1) AS "topMatch"`;

export function normaliseRow(r: IdeaRow): IdeaRow {
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  return {
    ...r,
    createdAt: ts(r.createdAt),
    updatedAt: ts(r.updatedAt),
    topMatch: r.topMatch ? { id: r.topMatch.id, score: Number(r.topMatch.score) } : null,
  };
}

/** List rows for a set of ideas, in the order given. One statement. */
export async function rowsByIds(db: Db, ids: string[]): Promise<IdeaRow[]> {
  if (!ids.length) return [];
  const { rows } = await sql<IdeaRow>`
    SELECT ${ROW_COLUMNS} FROM fh_idea i LEFT JOIN fh_idea_rollup r ON r.idea_id = i.id
    WHERE i.id = ANY(${ids}::uuid[])`.execute(db);
  const byId = new Map(rows.map((r) => [r.id, normaliseRow(r)]));
  return ids.map((id) => byId.get(id)).filter((r): r is IdeaRow => !!r);
}

export async function rowById(db: Db, id: string): Promise<IdeaRow> {
  return (await rowsByIds(db, [id]))[0];
}

/** Wrap a page query (`SELECT id, _ord, ...`) so aggregates only run for the page's ids (§4.5). */
export function rowsForPage(pageSql: RawBuilder<unknown>) {
  return sql<IdeaRow & { _page: { _sort: string | null; _ord: number; _key?: string | null; _rn?: number } }>`
    WITH page AS (${pageSql})
    SELECT ${ROW_COLUMNS}, to_jsonb(page) AS _page
    FROM page JOIN fh_idea i ON i.id = page.id LEFT JOIN fh_idea_rollup r ON r.idea_id = i.id
    ORDER BY page._ord`;
}

/** Strips the page bookkeeping column from a wrapped row. */
export function pageRow(r: IdeaRow & { _page: unknown }): IdeaRow {
  const { _page, ...row } = r;
  void _page;
  return normaliseRow(row as IdeaRow);
}
