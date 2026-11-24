// CSV export (FH-156, FH-157, SEC-18, SEC-19). Built on the server from the viewSpec or selected ids, so it covers
// rows not loaded in the browser. Visible columns in the user's order, current sort, no personal contact details.
import { sql } from 'kysely';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { audit, type Principal } from '@/modules/core/service';
import { COLUMN_BY_ID, type ViewSpec } from './columns';
import { EXPORT_MAX_ROWS, prioValue, statusKeyOf, statusLabel, TYPE_LABEL, SOURCE_LABEL, type IdeaType } from './domain';
import { exportOrder, fullWhere } from './query';
import { CSV_BOM, csvCell, csvRow } from './text';

interface ExportRow {
  number: number; title: string; status: string | null; bug_status: string | null; idea_type: IdeaType;
  owner: string | null; feature: string | null; milestone: string | null; companies: string[]; journeys: string[]; themes: string[];
  strategic_value: number | null; revenue_impact: number | null; customer_experience: number | null; risk_score: number | null; effort_score: number | null;
  user_count: number; company_count: number; arr: string; insight_count: number; distinct_voters: number; sources: string[];
  start_date: string | null; due_date: string | null; estimate_days: number | null; is_committed: boolean; is_dealbreaker: boolean;
  unreviewed: boolean; company_missing: boolean; dup: number | null; created_at: Date | string; updated_at: Date | string;
}

const day = (v: Date | string) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

function cellFor(col: string, r: ExportRow): [string | number | boolean | null, boolean] {
  switch (col) {
    case 'number': return [r.number, true];
    case 'title': return [r.title, false];
    case 'triage': return [[r.unreviewed && 'Unreviewed', r.company_missing && 'Company missing', r.dup !== null && `Duplicate? ${Math.round(r.dup * 100)}%`].filter(Boolean).join('; '), false];
    case 'source': return [(r.sources.length ? r.sources : ['MANUAL']).map((s) => SOURCE_LABEL[s as keyof typeof SOURCE_LABEL] ?? s).join('; '), false];
    case 'status': return [statusLabel(statusKeyOf({ status: r.status, bugStatus: r.bug_status }), true), false];
    case 'type': return [TYPE_LABEL[r.idea_type], false];
    case 'owner': return [r.owner, false];
    case 'feature': return [r.feature, false];
    case 'milestone': return [r.milestone, false];
    case 'companies': return [r.companies.join('; '), false];
    case 'journeys': return [r.journeys.join('; '), false];
    case 'themes': return [r.themes.join('; '), false];
    case 'strategicValue': return [r.strategic_value, true];
    case 'revenueImpact': return [r.revenue_impact, true];
    case 'customerExperience': return [r.customer_experience, true];
    case 'riskScore': return [r.risk_score, true];
    case 'effortScore': return [r.effort_score, true];
    case 'prio': return [prioValue({ strategicValue: r.strategic_value, revenueImpact: r.revenue_impact, customerExperience: r.customer_experience, riskScore: r.risk_score, effortScore: r.effort_score })?.toFixed(2) ?? null, true];
    case 'users': return [r.user_count, true];
    case 'companyCount': return [r.company_count, true];
    case 'arr': return [r.arr, true];
    case 'insights': return [r.insight_count, true];
    case 'votes': return [r.distinct_voters, true];
    case 'startDate': return [r.start_date, false];
    case 'dueDate': return [r.due_date, false];
    case 'estimateDays': return [r.estimate_days, true];
    case 'committed': return [r.is_committed ? 'Yes' : 'No', false];
    case 'dealbreaker': return [r.is_dealbreaker ? 'Yes' : 'No', false];
    case 'createdAt': return [day(r.created_at), false];
    case 'updatedAt': return [day(r.updated_at), false];
    default: return [null, false];
  }
}

/** Builds the file. One statement for the rows plus one audit row; the body streams in chunks. */
export async function exportCsv(p: Principal, spec: ViewSpec, columns: string[], ids: string[] | null): Promise<Response> {
  const cols = [...new Set(columns)].filter((c) => COLUMN_BY_ID[c]);
  if (!cols.length) throw new ApiError('validation', 'Choose at least one column.', { field: 'columns' });
  const where = ids ? sql`i.merged_into_id IS NULL AND i.id = ANY(${ids}::uuid[])` : fullWhere(spec);
  const { rows } = await sql<ExportRow>`
    SELECT i.number::int AS number, i.title, i.status, i.bug_status, i.idea_type,
      (SELECT COALESCE(u.full_name, u.email) FROM core_user u WHERE u.id = i.owner_id) AS owner,
      (SELECT f.name FROM fh_feature f WHERE f.id = i.feature_id) AS feature,
      (SELECT m.name FROM fh_milestone m WHERE m.id = i.milestone_id) AS milestone,
      ARRAY(SELECT c.name FROM fh_idea_company ic JOIN core_company c ON c.id = ic.company_id WHERE ic.idea_id = i.id ORDER BY c.name_key) AS companies,
      ARRAY(SELECT j.name FROM fh_idea_journey ij JOIN fh_journey j ON j.id = ij.journey_id WHERE ij.idea_id = i.id ORDER BY j.name_key) AS journeys,
      ARRAY(SELECT t.name FROM fh_idea_theme it JOIN fh_theme t ON t.id = it.theme_id WHERE it.idea_id = i.id ORDER BY t.name_key) AS themes,
      i.strategic_value, i.revenue_impact, i.customer_experience, i.risk_score, i.effort_score,
      COALESCE(r.user_count, 0) AS user_count, COALESCE(r.company_count, 0) AS company_count, COALESCE(r.arr, 0)::text AS arr,
      COALESCE(r.insight_count, 0) AS insight_count, COALESCE(r.distinct_voters, 0) AS distinct_voters, COALESCE(r.sources, '{}') AS sources,
      i.start_date::text AS start_date, i.due_date::text AS due_date, i.estimate_days, i.is_committed, i.is_dealbreaker,
      i.reviewed_at IS NULL AS unreviewed, (COALESCE(r.has_intake_source, false) AND COALESCE(r.company_count, 0) = 0) AS company_missing,
      (SELECT max(m.score)::float8 FROM fh_idea_match m JOIN fh_idea c ON c.id = m.candidate_id AND c.merged_into_id IS NULL WHERE m.idea_id = i.id) AS dup,
      i.created_at, i.updated_at
    FROM fh_idea i LEFT JOIN fh_idea_rollup r ON r.idea_id = i.id
    WHERE ${where} ORDER BY ${exportOrder(spec)} LIMIT ${EXPORT_MAX_ROWS}`.execute(getDb());

  await audit({
    actorKind: 'user', actorId: p.userId, action: 'fh.idea.export',
    details: { rows: rows.length, columns: cols, view: spec.view, filtered: !ids, includePersonalData: false },
  });

  const header = csvRow(cols.map((c) => csvCell(COLUMN_BY_ID[c].label)));
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(enc.encode(CSV_BOM + header)); },
    pull(controller) {
      // 500 rows per chunk keeps first bytes fast and memory flat (PERF-B21).
      let chunk = '';
      for (const end = Math.min(i + 500, rows.length); i < end; i++) {
        chunk += csvRow(cols.map((c) => { const [v, numeric] = cellFor(c, rows[i]); return csvCell(v, numeric); }));
      }
      if (chunk) controller.enqueue(enc.encode(chunk));
      if (i >= rows.length) controller.close();
    },
  });
  const date = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ideas-${spec.view}-${date}.csv"`,
      'Cache-Control': 'no-store',
      'x-export-rows': String(rows.length),
    },
  });
}
