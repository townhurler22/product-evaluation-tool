// Ideas table columns (FH-103 table) and the viewSpec that carries view, rail, filters, search and sort (PERF-11).
// Shared by the server (WHERE / ORDER BY, export) and the browser (layout, filters).
import { z } from 'zod';
import { VIEWS } from './domain';

export interface ColumnDef {
  id: string;
  label: string;
  /** Facet filter available (FH-106). */
  filter?: boolean;
  sort?: boolean;
  /** Written as a plain number in CSV (never formula-prefixed). */
  numeric?: boolean;
  /** Inline editor kind for admins (editors mount only on focus, PERF-11). */
  edit?: 'text' | 'status' | 'type' | 'owner' | 'feature' | 'milestone' | 'companies' | 'themes' | 'score' | 'date' | 'int' | 'bool';
  width: number;
}

export const COLUMNS: ColumnDef[] = [
  { id: 'number', label: '#', sort: true, numeric: true, width: 72 },
  { id: 'title', label: 'Title', sort: true, edit: 'text', width: 320 },
  { id: 'triage', label: 'Triage', filter: true, sort: true, width: 170 },
  { id: 'source', label: 'Source', filter: true, width: 140 },
  { id: 'status', label: 'Status', filter: true, sort: true, edit: 'status', width: 140 },
  { id: 'type', label: 'Type', filter: true, sort: true, edit: 'type', width: 140 },
  { id: 'owner', label: 'Owner', filter: true, sort: true, edit: 'owner', width: 150 },
  { id: 'feature', label: 'Feature', filter: true, sort: true, edit: 'feature', width: 170 },
  { id: 'milestone', label: 'Milestone', filter: true, sort: true, edit: 'milestone', width: 150 },
  { id: 'companies', label: 'Companies', filter: true, edit: 'companies', width: 180 },
  { id: 'journeys', label: 'Journeys', filter: true, width: 160 },
  { id: 'themes', label: 'Themes', filter: true, edit: 'themes', width: 170 },
  { id: 'strategicValue', label: 'Strategic', sort: true, numeric: true, edit: 'score', width: 90 },
  { id: 'revenueImpact', label: 'Revenue', sort: true, numeric: true, edit: 'score', width: 90 },
  { id: 'customerExperience', label: 'Customer experience', sort: true, numeric: true, edit: 'score', width: 110 },
  { id: 'riskScore', label: 'Risk', sort: true, numeric: true, edit: 'score', width: 80 },
  { id: 'effortScore', label: 'Effort', sort: true, numeric: true, edit: 'score', width: 80 },
  { id: 'prio', label: 'Prio-Value', sort: true, numeric: true, width: 100 },
  { id: 'users', label: 'Users', sort: true, numeric: true, width: 80 },
  { id: 'companyCount', label: 'Companies count', sort: true, numeric: true, width: 100 },
  { id: 'arr', label: 'ARR', sort: true, numeric: true, width: 110 },
  { id: 'insights', label: 'Insights', sort: true, numeric: true, width: 90 },
  { id: 'votes', label: 'Voters', sort: true, numeric: true, width: 80 }, // D-35: distinct voters; the vote total is in the panel
  { id: 'startDate', label: 'Start', sort: true, edit: 'date', width: 120 },
  { id: 'dueDate', label: 'Due', sort: true, edit: 'date', width: 120 },
  { id: 'estimateDays', label: 'Estimate (days)', sort: true, numeric: true, edit: 'int', width: 110 },
  { id: 'committed', label: 'Committed', filter: true, sort: true, edit: 'bool', width: 100 },
  { id: 'dealbreaker', label: 'Dealbreaker', filter: true, sort: true, edit: 'bool', width: 100 },
  { id: 'createdAt', label: 'Created', sort: true, width: 120 },
  { id: 'updatedAt', label: 'Updated', sort: true, width: 120 },
];
export const COLUMN_BY_ID = Object.fromEntries(COLUMNS.map((c) => [c.id, c])) as Record<string, ColumnDef>;
export const FILTER_COLUMNS = COLUMNS.filter((c) => c.filter).map((c) => c.id);
export const MIN_COLUMN_WIDTH = 56;

export const TRIAGE_FLAGS = ['UNREVIEWED', 'COMPANY_MISSING', 'DUPLICATE'] as const;
export const TRIAGE_LABEL: Record<(typeof TRIAGE_FLAGS)[number], string> = {
  UNREVIEWED: 'Unreviewed', COMPANY_MISSING: 'Company missing', DUPLICATE: 'Duplicate?',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);
export const Uuid = z.string().regex(UUID_RE, 'Must be an id');

export const ViewSpecSchema = z.object({
  view: z.enum(VIEWS).default('all'),
  rail: z.object({
    featureId: Uuid.nullish(),
    includeSub: z.boolean().optional(),
    journeyId: Uuid.nullish(),
  }).default({}),
  // FH-106: a set of facet values per column; null means the "no value" facet. Unknown columns are ignored (FH-108).
  filters: z.record(z.string().max(40), z.array(z.string().max(80).nullable()).max(500)).default({}),
  search: z.string().max(200).default(''),
  sort: z.object({ column: z.string().max(40), dir: z.enum(['asc', 'desc']) }).nullish(),
});
export type ViewSpec = z.infer<typeof ViewSpecSchema>;
export type ViewSpecInput = z.input<typeof ViewSpecSchema>;

/** Query-string form used by GET routes: `?spec=<json>`. */
export const encodeSpec = (s: ViewSpecInput) => encodeURIComponent(JSON.stringify(s));
