// viewSpec → WHERE / ORDER BY on the server (PERF-11). Lists are keyset-paginated on (sort value, id), page 100,
// with no hidden cap (FH-102, D-06). Every function here runs a fixed number of statements.
import { sql, type RawBuilder } from 'kysely';
import { ApiError } from '@/server/http/errors';
import { COLUMN_BY_ID, isUuid, type ViewSpec } from './columns';
import { IDEA_TYPES, IDS_CAP, PAGE_SIZE, BOARD_PAGE, STATUS_KEYS, type View } from './domain';
import { rowsForPage, pageRow, type IdeaRow } from './rows';
import type { Db } from './store';

type Frag = RawBuilder<unknown>;
const join = (parts: Frag[], sep: string) => sql.join(parts, sql.raw(sep));
const TRUE = sql`true`;

const STATUS_KEY_SQL = sql`COALESCE('IDEA_' || i.status, 'BUG_' || i.bug_status)`;
const LIVE_MATCH = sql`EXISTS (SELECT 1 FROM fh_idea_match m JOIN fh_idea c ON c.id = m.candidate_id AND c.merged_into_id IS NULL WHERE m.idea_id = i.id)`;
const COMPANY_MISSING = sql`(COALESCE(r.has_intake_source, false) AND COALESCE(r.company_count, 0) = 0)`;
const PRIO = sql`(CASE WHEN i.strategic_value IS NULL OR i.revenue_impact IS NULL OR i.customer_experience IS NULL
  OR i.risk_score IS NULL OR i.effort_score IS NULL THEN NULL ELSE LEAST(10, GREATEST(1, round(0.2 * i.strategic_value
  + 0.3 * i.revenue_impact + 0.25 * i.customer_experience - 0.1 * i.risk_score - 0.15 * i.effort_score, 2) + 2.75)) END)`;

/** FH-101 view predicates; the same rules as `matchesView` in domain.ts. */
export function viewWhere(view: View): Frag {
  switch (view) {
    case 'all': case 'board': return TRUE;
    case 'triage': return sql`(i.status = 'OPEN' OR i.bug_status = 'OPEN')`;
    case 'backlog': return sql`(i.status = 'BACKLOG' OR i.bug_status = 'TRIAGED')`;
    case 'roadmap': return sql`(i.start_date IS NOT NULL AND (i.status IN ('PLANNED','IN_PROGRESS','COMPLETE') OR i.bug_status IN ('IN_DEV','FIXED','RELEASED')))`;
  }
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, '\\$&');

/** View + rail + search: the base set that facets count over (FH-107). */
export function baseWhere(spec: ViewSpec): Frag {
  const parts: Frag[] = [sql`i.merged_into_id IS NULL`, viewWhere(spec.view)];
  const { featureId, includeSub, journeyId } = spec.rail;
  if (featureId) {
    parts.push(includeSub
      ? sql`i.feature_id IN (SELECT descendant_id FROM fh_feature_closure WHERE ancestor_id = ${featureId}::uuid)`
      : sql`i.feature_id = ${featureId}::uuid`);
  }
  if (journeyId) parts.push(sql`EXISTS (SELECT 1 FROM fh_idea_journey ij WHERE ij.idea_id = i.id AND ij.journey_id = ${journeyId}::uuid)`);
  const q = spec.search.trim();
  if (q) parts.push(sql`i.title ILIKE ${'%' + likeEscape(q) + '%'}`); // FH-103: title only, case-insensitive
  return join(parts, ' AND ');
}

/** One column filter: any selected value (OR); null means "no value". Unknown columns are ignored (FH-108). */
function columnFilter(column: string, values: (string | null)[]): Frag | null {
  const set = [...new Set(values.filter((v): v is string => v !== null))];
  const none = values.includes(null);
  const ids = set.filter(isUuid);
  const anyOf = (single: Frag) => {
    const ors: Frag[] = [];
    if (ids.length) ors.push(sql`${single} = ANY(${ids}::uuid[])`);
    if (none) ors.push(sql`${single} IS NULL`);
    return ors.length ? sql`(${join(ors, ' OR ')})` : sql`false`;
  };
  const linkFilter = (table: string, col: string) => {
    const ors: Frag[] = [];
    if (ids.length) ors.push(sql`EXISTS (SELECT 1 FROM ${sql.table(table)} x WHERE x.idea_id = i.id AND ${sql.ref('x.' + col)} = ANY(${ids}::uuid[]))`);
    if (none) ors.push(sql`NOT EXISTS (SELECT 1 FROM ${sql.table(table)} x WHERE x.idea_id = i.id)`);
    return ors.length ? sql`(${join(ors, ' OR ')})` : sql`false`;
  };
  switch (column) {
    case 'status': {
      const keys = set.filter((s) => (STATUS_KEYS as string[]).includes(s));
      return keys.length ? sql`${STATUS_KEY_SQL} = ANY(${keys}::text[])` : sql`false`;
    }
    case 'type': {
      const types = set.filter((s) => (IDEA_TYPES as readonly string[]).includes(s));
      return types.length ? sql`i.idea_type = ANY(${types}::text[])` : sql`false`;
    }
    case 'owner': return anyOf(sql`i.owner_id`);
    case 'feature': return anyOf(sql`i.feature_id`);
    case 'milestone': return anyOf(sql`i.milestone_id`);
    case 'companies': return linkFilter('fh_idea_company', 'company_id');
    case 'themes': return linkFilter('fh_idea_theme', 'theme_id');
    case 'journeys': return linkFilter('fh_idea_journey', 'journey_id');
    case 'source': {
      // FH-105: one facet per source, so an idea with several sources is found under each. No insights = Manual.
      const ors: Frag[] = [];
      if (set.length) ors.push(sql`COALESCE(r.sources, '{}') && ${set}::text[]`);
      if (set.includes('MANUAL')) ors.push(sql`COALESCE(r.sources, '{}') = '{}'`);
      return ors.length ? sql`(${join(ors, ' OR ')})` : sql`false`;
    }
    case 'triage': {
      const ors: Frag[] = [];
      if (set.includes('UNREVIEWED')) ors.push(sql`i.reviewed_at IS NULL`);
      if (set.includes('COMPANY_MISSING')) ors.push(COMPANY_MISSING);
      if (set.includes('DUPLICATE')) ors.push(LIVE_MATCH);
      if (none) ors.push(sql`(i.reviewed_at IS NOT NULL AND NOT ${COMPANY_MISSING} AND NOT ${LIVE_MATCH})`);
      return ors.length ? sql`(${join(ors, ' OR ')})` : sql`false`;
    }
    case 'committed': case 'dealbreaker': {
      const col = column === 'committed' ? sql`i.is_committed` : sql`i.is_dealbreaker`;
      const vals = set.filter((v) => v === 'true' || v === 'false').map((v) => v === 'true');
      return vals.length ? sql`${col} = ANY(${vals}::bool[])` : sql`false`;
    }
    default: return null;
  }
}

/** Base + every column filter (AND across columns). */
export function fullWhere(spec: ViewSpec, skipColumn?: string): Frag {
  const parts = [baseWhere(spec)];
  for (const [col, values] of Object.entries(spec.filters)) {
    if (col === skipColumn || !values.length) continue;
    const f = columnFilter(col, values);
    if (f) parts.push(f);
  }
  return join(parts, ' AND ');
}

// ── sorting (FH-110) ─────────────────────────────────────────────────────────
interface SortDef { expr: Frag; cast: string }
const SORTS: Record<string, SortDef> = {
  number: { expr: sql`i.number`, cast: 'bigint' },
  title: { expr: sql`lower(i.title)`, cast: 'text' },
  triage: { expr: sql`((i.reviewed_at IS NULL)::int + ${COMPANY_MISSING}::int + ${LIVE_MATCH}::int)`, cast: 'int' },
  status: { expr: sql`array_position(${STATUS_KEYS}::text[], ${STATUS_KEY_SQL})`, cast: 'int' },
  type: { expr: sql`array_position(${[...IDEA_TYPES]}::text[], i.idea_type)`, cast: 'int' },
  owner: { expr: sql`(SELECT lower(COALESCE(u.full_name, u.email)) FROM core_user u WHERE u.id = i.owner_id)`, cast: 'text' },
  feature: { expr: sql`(SELECT lower(f.name) FROM fh_feature f WHERE f.id = i.feature_id)`, cast: 'text' },
  milestone: { expr: sql`(SELECT ms.date FROM fh_milestone ms WHERE ms.id = i.milestone_id)`, cast: 'date' },
  strategicValue: { expr: sql`i.strategic_value`, cast: 'int' },
  revenueImpact: { expr: sql`i.revenue_impact`, cast: 'int' },
  customerExperience: { expr: sql`i.customer_experience`, cast: 'int' },
  riskScore: { expr: sql`i.risk_score`, cast: 'int' },
  effortScore: { expr: sql`i.effort_score`, cast: 'int' },
  prio: { expr: PRIO, cast: 'numeric' },
  users: { expr: sql`COALESCE(r.user_count, 0)`, cast: 'int' },
  companyCount: { expr: sql`COALESCE(r.company_count, 0)`, cast: 'int' },
  arr: { expr: sql`COALESCE(r.arr, 0)`, cast: 'numeric' },
  insights: { expr: sql`COALESCE(r.insight_count, 0)`, cast: 'int' },
  votes: { expr: sql`COALESCE(r.distinct_voters, 0)`, cast: 'int' },
  startDate: { expr: sql`i.start_date`, cast: 'date' },
  dueDate: { expr: sql`i.due_date`, cast: 'date' },
  estimateDays: { expr: sql`i.estimate_days`, cast: 'int' },
  committed: { expr: sql`i.is_committed`, cast: 'bool' },
  dealbreaker: { expr: sql`i.is_dealbreaker`, cast: 'bool' },
  createdAt: { expr: sql`i.created_at`, cast: 'timestamptz' },
  updatedAt: { expr: sql`i.updated_at`, cast: 'timestamptz' },
};

export function effectiveSort(spec: ViewSpec): { column: string; dir: 'asc' | 'desc' } {
  if (spec.sort && SORTS[spec.sort.column] && COLUMN_BY_ID[spec.sort.column]?.sort) return spec.sort;
  if (spec.view === 'triage' || spec.view === 'backlog') return { column: 'updatedAt', dir: 'desc' };
  if (spec.view === 'roadmap') return { column: 'startDate', dir: 'asc' };
  return { column: 'createdAt', dir: 'desc' };
}

interface Cursor { v: string | null; id: string }
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (isUuid(c?.id) && (c.v === null || typeof c.v === 'string')) return c;
  } catch { /* fall through */ }
  throw new ApiError('validation', 'The page cursor is not valid.', { field: 'cursor' });
}

/** ORDER BY with nulls last in both directions; ties break on id (FH-110). */
function orderAndSeek(spec: ViewSpec, cursor: Cursor | null): { order: Frag; seek: Frag; sortExpr: Frag } {
  const s = effectiveSort(spec);
  const def = SORTS[s.column];
  const dir = sql.raw(s.dir === 'asc' ? 'ASC' : 'DESC');
  const order = sql`${def.expr} ${dir} NULLS LAST, i.id ASC`;
  let seek: Frag = TRUE;
  if (cursor) {
    if (cursor.v === null) {
      seek = sql`(${def.expr} IS NULL AND i.id > ${cursor.id}::uuid)`;
    } else {
      const v = sql`CAST(${cursor.v} AS ${sql.raw(def.cast)})`;
      const beyond = s.dir === 'asc' ? sql`${def.expr} > ${v}` : sql`${def.expr} < ${v}`;
      seek = sql`(${beyond} OR (${def.expr} = ${v} AND i.id > ${cursor.id}::uuid) OR ${def.expr} IS NULL)`;
    }
  }
  return { order, seek, sortExpr: def.expr };
}

const FROM = sql`fh_idea i LEFT JOIN fh_idea_rollup r ON r.idea_id = i.id`;

/** GET ideas: one page of rows plus the total on the first page. ≤ 2 statements (budget 4 with preamble). */
export async function listIdeas(db: Db, spec: ViewSpec, rawCursor: string | null, limit = PAGE_SIZE) {
  const cursor = decodeCursor(rawCursor);
  const where = fullWhere(spec);
  const { order, seek, sortExpr } = orderAndSeek(spec, cursor);
  const page = sql`
    SELECT i.id, (${sortExpr})::text AS _sort, row_number() OVER (ORDER BY ${order}) AS _ord
    FROM ${FROM} WHERE ${where} AND ${seek} ORDER BY ${order} LIMIT ${limit + 1}`;
  const { rows } = await rowsForPage(page).execute(db);
  const more = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const nextCursor = more && last ? encodeCursor({ v: last._page._sort, id: last.id }) : null;
  let total: number | undefined;
  if (!cursor) {
    const c = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${FROM} WHERE ${where}`.execute(db);
    total = c.rows[0].n;
  }
  const out: IdeaRow[] = pageRows.map(pageRow);
  return { rows: out, nextCursor, ...(total !== undefined && { total }) };
}

/** POST ideas/ids: every matching id in sort order, capped at 5,000, with the total. One statement. */
export async function matchingIds(db: Db, spec: ViewSpec): Promise<{ ids: string[]; total: number }> {
  const { order } = orderAndSeek(spec, null);
  const { rows } = await sql<{ id: string; total: number }>`
    SELECT i.id, count(*) OVER ()::int AS total FROM ${FROM} WHERE ${fullWhere(spec)} ORDER BY ${order} LIMIT ${IDS_CAP}`.execute(db);
  return { ids: rows.map((r) => r.id), total: rows[0]?.total ?? 0 };
}

// ── facets (FH-107) ──────────────────────────────────────────────────────────
export interface Facet { value: string | null; label: string; count: number }

/** Counts for one column over the current view, rail and search, before column filters. One statement. */
export async function facets(db: Db, spec: ViewSpec, column: string, q: string | null): Promise<Facet[]> {
  const base = sql`SELECT i.*, r.sources AS r_sources, r.has_intake_source, r.company_count
                   FROM ${FROM} WHERE ${baseWhere(spec)}`;
  const search = q?.trim() ? `%${likeEscape(q.trim())}%` : null;
  let query: Frag;
  switch (column) {
    case 'status':
      query = sql`SELECT COALESCE('IDEA_' || i.status, 'BUG_' || i.bug_status) AS value, NULL AS label, count(*)::int AS count
                  FROM base i GROUP BY 1`;
      break;
    case 'type':
      query = sql`SELECT i.idea_type AS value, NULL AS label, count(*)::int AS count FROM base i GROUP BY 1`;
      break;
    case 'owner':
      query = sql`SELECT i.owner_id::text AS value, COALESCE(u.full_name, u.email) AS label, count(*)::int AS count
                  FROM base i LEFT JOIN core_user u ON u.id = i.owner_id
                  WHERE ${search ? sql`(i.owner_id IS NULL OR COALESCE(u.full_name, u.email) ILIKE ${search})` : TRUE}
                  GROUP BY 1, 2 ORDER BY count DESC, label LIMIT 51`;
      break;
    case 'feature':
      query = sql`SELECT i.feature_id::text AS value, f.name AS label, count(*)::int AS count
                  FROM base i LEFT JOIN fh_feature f ON f.id = i.feature_id GROUP BY 1, 2`;
      break;
    case 'milestone':
      query = sql`SELECT i.milestone_id::text AS value, m.name AS label, count(*)::int AS count
                  FROM base i LEFT JOIN fh_milestone m ON m.id = i.milestone_id GROUP BY 1, 2`;
      break;
    case 'companies':
      query = sql`(SELECT c.id::text AS value, c.name AS label, count(*)::int AS count
                   FROM base i JOIN fh_idea_company ic ON ic.idea_id = i.id JOIN core_company c ON c.id = ic.company_id
                   WHERE ${search ? sql`c.name ILIKE ${search}` : TRUE}
                   GROUP BY 1, 2 ORDER BY count DESC, label LIMIT 50)
                  UNION ALL
                  SELECT NULL, NULL, count(*)::int FROM base i WHERE NOT EXISTS (SELECT 1 FROM fh_idea_company ic WHERE ic.idea_id = i.id)`;
      break;
    case 'themes':
      query = sql`SELECT t.id::text AS value, t.name AS label, count(*)::int AS count
                  FROM base i JOIN fh_idea_theme it ON it.idea_id = i.id JOIN fh_theme t ON t.id = it.theme_id GROUP BY 1, 2
                  UNION ALL
                  SELECT NULL, NULL, count(*)::int FROM base i WHERE NOT EXISTS (SELECT 1 FROM fh_idea_theme it WHERE it.idea_id = i.id)`;
      break;
    case 'journeys':
      query = sql`SELECT j.id::text AS value, j.name AS label, count(*)::int AS count
                  FROM base i JOIN fh_idea_journey ij ON ij.idea_id = i.id JOIN fh_journey j ON j.id = ij.journey_id GROUP BY 1, 2
                  UNION ALL
                  SELECT NULL, NULL, count(*)::int FROM base i WHERE NOT EXISTS (SELECT 1 FROM fh_idea_journey ij WHERE ij.idea_id = i.id)`;
      break;
    case 'source':
      query = sql`SELECT s AS value, NULL AS label, count(*)::int AS count
                  FROM base i, unnest(CASE WHEN COALESCE(i.r_sources, '{}') = '{}' THEN ARRAY['MANUAL'] ELSE i.r_sources END) s
                  GROUP BY 1`;
      break;
    case 'triage': {
      const missing = sql`(COALESCE(i.has_intake_source, false) AND COALESCE(i.company_count, 0) = 0)`;
      const dup = sql`EXISTS (SELECT 1 FROM fh_idea_match m JOIN fh_idea c ON c.id = m.candidate_id AND c.merged_into_id IS NULL WHERE m.idea_id = i.id)`;
      query = sql`WITH f AS (SELECT (i.reviewed_at IS NULL) AS unrev, ${missing} AS missing, ${dup} AS dup FROM base i)
                  SELECT 'UNREVIEWED' AS value, NULL AS label, count(*) FILTER (WHERE unrev)::int AS count FROM f
                  UNION ALL SELECT 'COMPANY_MISSING', NULL, count(*) FILTER (WHERE missing)::int FROM f
                  UNION ALL SELECT 'DUPLICATE', NULL, count(*) FILTER (WHERE dup)::int FROM f
                  UNION ALL SELECT NULL, NULL, count(*) FILTER (WHERE NOT unrev AND NOT missing AND NOT dup)::int FROM f`;
      break;
    }
    case 'committed': case 'dealbreaker':
      query = sql`SELECT (${column === 'committed' ? sql`i.is_committed` : sql`i.is_dealbreaker`})::text AS value,
                  NULL AS label, count(*)::int AS count FROM base i GROUP BY 1`;
      break;
    default:
      throw new ApiError('validation', 'That column has no filter.', { field: 'column' });
  }
  const { rows } = await sql<Facet>`WITH base AS (${base}) ${query}`.execute(db);
  return rows.map((r) => ({ value: r.value, label: r.label ?? '', count: Number(r.count) }));
}

// ── roadmap (FH-761) and board (FH-771–773) ──────────────────────────────────
/** Roadmap rows overlapping [from, to] (the client passes the visible window plus one either side). One + one statements. */
export async function roadmapRows(db: Db, spec: ViewSpec, from: string, to: string, rawCursor: string | null) {
  const roadmapSpec: ViewSpec = { ...spec, view: 'roadmap', sort: { column: 'startDate', dir: 'asc' } };
  const cursor = decodeCursor(rawCursor);
  const { order, seek, sortExpr } = orderAndSeek(roadmapSpec, cursor);
  const overlap = sql`i.start_date <= ${to}::date AND COALESCE(i.due_date, i.start_date) >= ${from}::date`;
  const page = sql`
    SELECT i.id, (${sortExpr})::text AS _sort, row_number() OVER (ORDER BY ${order}) AS _ord
    FROM ${FROM} WHERE ${fullWhere(roadmapSpec)} AND ${overlap} AND ${seek} ORDER BY ${order} LIMIT ${PAGE_SIZE + 1}`;
  const { rows } = await rowsForPage(page).execute(db);
  const more = rows.length > PAGE_SIZE;
  const pageRows = rows.slice(0, PAGE_SIZE);
  const last = pageRows[pageRows.length - 1];
  return {
    rows: pageRows.map(pageRow),
    nextCursor: more && last ? encodeCursor({ v: last._page._sort, id: last.id }) : null,
  };
}

export const BOARD_GROUPS = ['status', 'type', 'owner', 'feature'] as const;
export type BoardGroup = (typeof BOARD_GROUPS)[number];

function groupExpr(group: BoardGroup): Frag {
  switch (group) {
    case 'status': return STATUS_KEY_SQL;
    case 'type': return sql`i.idea_type`;
    case 'owner': return sql`i.owner_id::text`;
    case 'feature': return sql`i.feature_id::text`;
  }
}

/**
 * GET board: the first 50 cards of every column plus each column's total (two statements); with `column`,
 * the next page of that one column (FH-773). Cards follow the All view's default order (created, newest first).
 */
export async function boardColumns(db: Db, spec: ViewSpec, group: BoardGroup, column: string | null | undefined, rawCursor: string | null) {
  const boardSpec: ViewSpec = { ...spec, view: 'board', sort: null };
  const g = groupExpr(group);
  const cursor = column !== undefined ? decodeCursor(rawCursor) : null;
  const { order, seek, sortExpr } = orderAndSeek(boardSpec, cursor);
  const where = fullWhere(boardSpec);
  type Col = { key: string | null; total: number | null; rows: IdeaRow[]; nextCursor: string | null };
  const cols = new Map<string | null, Col>();
  const lastSort = new Map<string, string | null>();
  const colOf = (key: string | null) => {
    if (!cols.has(key)) cols.set(key, { key, total: null, rows: [], nextCursor: null });
    return cols.get(key)!;
  };

  const page = column !== undefined
    ? sql`SELECT i.id, ${g} AS _key, (${sortExpr})::text AS _sort, row_number() OVER (ORDER BY ${order}) AS _rn,
                 row_number() OVER (ORDER BY ${order}) AS _ord
          FROM ${FROM} WHERE ${where} AND ${column === null ? sql`${g} IS NULL` : sql`${g} = ${column}`} AND ${seek}
          ORDER BY ${order} LIMIT ${BOARD_PAGE + 1}`
    : sql`SELECT id, _key, _sort, _rn, _ord FROM (
            SELECT i.id, ${g} AS _key, (${sortExpr})::text AS _sort,
                   row_number() OVER (PARTITION BY ${g} ORDER BY ${order}) AS _rn,
                   row_number() OVER (ORDER BY ${g} NULLS LAST, ${order}) AS _ord
            FROM ${FROM} WHERE ${where}) ranked
          WHERE _rn <= ${BOARD_PAGE + 1}`;
  const { rows } = await rowsForPage(page).execute(db);
  for (const r of rows) {
    const col = colOf(r._page._key ?? null);
    if ((r._page._rn ?? 0) > BOARD_PAGE) {
      const last = col.rows[col.rows.length - 1];
      col.nextCursor = encodeCursor({ v: lastSort.get(last.id) ?? null, id: last.id });
      continue;
    }
    col.rows.push(pageRow(r));
    lastSort.set(r.id, r._page._sort);
  }
  if (column === undefined) {
    const totals = await sql<{ key: string | null; total: number }>`
      SELECT ${g} AS key, count(*)::int AS total FROM ${FROM} WHERE ${where} GROUP BY 1`.execute(db);
    for (const t of totals.rows) colOf(t.key).total = t.total;
  } else {
    colOf(column);
  }
  return { columns: [...cols.values()] };
}
