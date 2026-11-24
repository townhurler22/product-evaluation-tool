// Feedback Hub pure domain rules, shared by the server and the browser (NFR-15). No I/O, no server imports.

export const IDEA_TYPES = ['FEATURE_REQUEST', 'IMPROVEMENT', 'INITIATIVE', 'BUG', 'QUESTION'] as const;
export type IdeaType = (typeof IDEA_TYPES)[number];
export const IDEA_STATUSES = ['OPEN', 'BACKLOG', 'UNDER_REVIEW', 'PLANNED', 'IN_PROGRESS', 'COMPLETE', 'CLOSED'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];
export const BUG_STATUSES = ['OPEN', 'TRIAGED', 'IN_DEV', 'FIXED', 'RELEASED', 'CANNOT_REPRODUCE', 'CLOSED'] as const;
export type BugStatus = (typeof BUG_STATUSES)[number];
/** Status key used across both workflows: `IDEA_<STATUS>` or `BUG_<STATUS>` (FH-310). */
export type StatusKey = `IDEA_${IdeaStatus}` | `BUG_${BugStatus}`;
export const STATUS_KEYS: StatusKey[] = [
  ...IDEA_STATUSES.map((s) => `IDEA_${s}` as StatusKey), ...BUG_STATUSES.map((s) => `BUG_${s}` as StatusKey),
];

export const TYPE_LABEL: Record<IdeaType, string> = {
  FEATURE_REQUEST: 'Feature request', IMPROVEMENT: 'Improvement', INITIATIVE: 'Initiative', BUG: 'Bug', QUESTION: 'Question',
};
export const IDEA_STATUS_LABEL: Record<IdeaStatus, string> = {
  OPEN: 'Open', BACKLOG: 'Backlog', UNDER_REVIEW: 'Under review', PLANNED: 'Planned', IN_PROGRESS: 'In progress',
  COMPLETE: 'Complete', CLOSED: 'Closed',
};
export const BUG_STATUS_LABEL: Record<BugStatus, string> = {
  OPEN: 'Open', TRIAGED: 'Triaged', IN_DEV: 'In development', FIXED: 'Fixed', RELEASED: 'Released',
  CANNOT_REPRODUCE: 'Cannot reproduce', CLOSED: 'Closed',
};

export function statusKeyOf(r: { status: string | null; bugStatus: string | null }): StatusKey | null {
  if (r.status && !r.bugStatus) return `IDEA_${r.status}` as StatusKey;
  if (r.bugStatus && !r.status) return `BUG_${r.bugStatus}` as StatusKey;
  return null; // FH-309: a row that breaks the shape shows "No status"
}

export function statusLabel(key: StatusKey | null, withWorkflow = false): string {
  if (!key) return 'No status';
  if (key.startsWith('IDEA_')) return IDEA_STATUS_LABEL[key.slice(5) as IdeaStatus];
  const l = BUG_STATUS_LABEL[key.slice(4) as BugStatus];
  return withWorkflow ? `Bug · ${l}` : l;
}

// FH-302 allowed transitions. Moving to the same status is a no-op and allowed.
const IDEA_NEXT: Record<IdeaStatus, IdeaStatus[]> = {
  OPEN: ['BACKLOG', 'UNDER_REVIEW', 'PLANNED', 'IN_PROGRESS', 'COMPLETE', 'CLOSED'],
  BACKLOG: ['OPEN', 'UNDER_REVIEW', 'PLANNED', 'CLOSED'],
  UNDER_REVIEW: ['OPEN', 'BACKLOG', 'PLANNED', 'CLOSED'],
  PLANNED: ['BACKLOG', 'UNDER_REVIEW', 'IN_PROGRESS', 'COMPLETE', 'CLOSED'],
  IN_PROGRESS: ['PLANNED', 'BACKLOG', 'COMPLETE', 'CLOSED'],
  COMPLETE: ['OPEN', 'BACKLOG', 'UNDER_REVIEW', 'PLANNED', 'IN_PROGRESS', 'CLOSED'],
  CLOSED: ['OPEN', 'BACKLOG', 'UNDER_REVIEW', 'PLANNED', 'IN_PROGRESS', 'COMPLETE'],
};
const BUG_NEXT: Record<BugStatus, BugStatus[]> = {
  OPEN: ['TRIAGED', 'IN_DEV', 'CANNOT_REPRODUCE', 'CLOSED'],
  TRIAGED: ['OPEN', 'IN_DEV', 'CANNOT_REPRODUCE', 'CLOSED'],
  IN_DEV: ['TRIAGED', 'FIXED', 'CANNOT_REPRODUCE', 'CLOSED'],
  FIXED: ['IN_DEV', 'RELEASED', 'CLOSED'],
  RELEASED: ['OPEN', 'TRIAGED', 'IN_DEV', 'FIXED', 'CANNOT_REPRODUCE', 'CLOSED'],
  CANNOT_REPRODUCE: ['OPEN', 'TRIAGED', 'CLOSED'],
  CLOSED: ['OPEN', 'TRIAGED', 'IN_DEV', 'FIXED', 'RELEASED', 'CANNOT_REPRODUCE'],
};

/** Targets the UI may offer from a status (including the current one). */
export function allowedTargets(from: StatusKey): StatusKey[] {
  if (from.startsWith('IDEA_')) {
    const s = from.slice(5) as IdeaStatus;
    return [from, ...IDEA_NEXT[s].map((t) => `IDEA_${t}` as StatusKey)];
  }
  const s = from.slice(4) as BugStatus;
  return [from, ...BUG_NEXT[s].map((t) => `BUG_${t}` as StatusKey)];
}

export function canTransition(from: StatusKey, to: StatusKey): boolean {
  return allowedTargets(from).includes(to);
}

export const sameWorkflow = (a: StatusKey, b: StatusKey) => a.startsWith('BUG_') === b.startsWith('BUG_');

// FH-307 type change remap.
const IDEA_TO_BUG: Record<IdeaStatus, BugStatus> = {
  OPEN: 'OPEN', BACKLOG: 'TRIAGED', UNDER_REVIEW: 'TRIAGED', PLANNED: 'TRIAGED', IN_PROGRESS: 'IN_DEV',
  COMPLETE: 'RELEASED', CLOSED: 'CLOSED',
};
const BUG_TO_IDEA: Record<BugStatus, IdeaStatus> = {
  OPEN: 'OPEN', TRIAGED: 'UNDER_REVIEW', IN_DEV: 'IN_PROGRESS', FIXED: 'IN_PROGRESS', RELEASED: 'COMPLETE',
  CANNOT_REPRODUCE: 'CLOSED', CLOSED: 'CLOSED',
};

export function remapForType(
  cur: { ideaType: IdeaType; status: IdeaStatus | null; bugStatus: BugStatus | null }, to: IdeaType,
): { status: IdeaStatus | null; bugStatus: BugStatus | null } {
  const fromBug = cur.ideaType === 'BUG', toBug = to === 'BUG';
  if (fromBug === toBug) return { status: cur.status, bugStatus: cur.bugStatus };
  if (toBug) return { status: null, bugStatus: IDEA_TO_BUG[cur.status ?? 'OPEN'] };
  return { status: BUG_TO_IDEA[cur.bugStatus ?? 'OPEN'], bugStatus: null };
}

/** Roadmap statuses (FH-101 Roadmap view, FH-305 default dates). */
export const ROADMAP_KEYS: StatusKey[] = ['IDEA_PLANNED', 'IDEA_IN_PROGRESS', 'IDEA_COMPLETE', 'BUG_IN_DEV', 'BUG_FIXED', 'BUG_RELEASED'];

/** §5.2 Open demand. A Fixed bug still counts. */
export function isOpenDemand(key: StatusKey | null): boolean {
  if (!key) return false;
  return !['IDEA_COMPLETE', 'IDEA_CLOSED', 'BUG_RELEASED', 'BUG_CLOSED', 'BUG_CANNOT_REPRODUCE'].includes(key);
}

// ── dates (UTC calendar days, FH-765) ───────────────────────────────────────
export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** FH-305: entering a roadmap status with no start sets start = today; empty due becomes start + 7. */
export function roadmapDefaults(
  to: StatusKey, cur: { startDate: string | null; dueDate: string | null }, now = new Date(),
): { startDate: string | null; dueDate: string | null } {
  if (!ROADMAP_KEYS.includes(to) || cur.startDate) return cur;
  const start = todayUtc(now);
  return { startDate: start, dueDate: cur.dueDate && cur.dueDate >= start ? cur.dueDate : addDays(start, 7) };
}

/** FH-766: estimate = max(1, round(due − start in days)). */
export const estimateFor = (start: string, due: string) => Math.max(1, Math.round(daysBetween(start, due)));

/** FH-767 release train markers every `length` days from the anchor, in both directions, within [from, to]. */
export function releaseTrainDates(anchor: string, length: number, from: string, to: string): string[] {
  const k0 = Math.ceil(daysBetween(anchor, from) / length);
  const out: string[] = [];
  for (let k = k0; ; k++) {
    const d = addDays(anchor, k * length);
    if (d > to) break;
    out.push(d);
  }
  return out;
}

// ── Prio-Value (FH-312) ─────────────────────────────────────────────────────
export interface Scores {
  strategicValue: number | null; revenueImpact: number | null; customerExperience: number | null;
  riskScore: number | null; effortScore: number | null;
}
/** Displayed Prio-Value, 1–10 to 2 decimals; blank (null) if any input is unscored. Never stored. */
export function prioValue(s: Scores): number | null {
  const v = [s.strategicValue, s.revenueImpact, s.customerExperience, s.riskScore, s.effortScore];
  if (v.some((x) => x === null || x === undefined)) return null;
  const raw = Math.round((0.2 * s.strategicValue! + 0.3 * s.revenueImpact! + 0.25 * s.customerExperience!
    - 0.1 * s.riskScore! - 0.15 * s.effortScore!) * 100) / 100;
  const shown = Math.min(10, Math.max(1, 1 + (9 * (raw + 1.75)) / 9));
  return Math.round(shown * 100) / 100;
}

// ── views (FH-101): one predicate for server and client ─────────────────────
export const VIEWS = ['all', 'triage', 'backlog', 'roadmap', 'board'] as const;
export type View = (typeof VIEWS)[number];
export const VIEW_LABEL: Record<View, string> = { all: 'All', triage: 'Triage', backlog: 'Backlog', roadmap: 'Roadmap', board: 'Board' };

export function matchesView(view: View, r: { status: string | null; bugStatus: string | null; startDate: string | null }): boolean {
  const key = statusKeyOf(r);
  switch (view) {
    case 'all': case 'board': return true;
    case 'triage': return key === 'IDEA_OPEN' || key === 'BUG_OPEN';
    case 'backlog': return key === 'IDEA_BACKLOG' || key === 'BUG_TRIAGED';
    case 'roadmap': return !!r.startDate && !!key && ROADMAP_KEYS.includes(key);
  }
}

/** Which view an edited row now belongs to, for the "moved to <view>" marker on held rows (FH-109). */
export function homeView(r: { status: string | null; bugStatus: string | null; startDate: string | null }): View {
  if (matchesView('triage', r)) return 'triage';
  if (matchesView('backlog', r)) return 'backlog';
  if (matchesView('roadmap', r)) return 'roadmap';
  return 'all';
}

// ── bulk (FH-154): the client chunk size equals the server cap; a test keeps them equal ───────────
export const BULK_CHUNK = 200;
export const IDS_CAP = 5_000;
export const PAGE_SIZE = 100;
export const BOARD_PAGE = 50;
export const EXPORT_MAX_ROWS = 50_000;

export const INSIGHT_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'DEALBREAKER'] as const;
export const SOURCES = ['FORUM', 'SUPPORT_BUTTON', 'CALL', 'MANUAL', 'CRM', 'CHAT', 'EMAIL'] as const;
export const SOURCE_LABEL: Record<(typeof SOURCES)[number], string> = {
  FORUM: 'Forum', SUPPORT_BUTTON: 'Support button', CALL: 'Call', MANUAL: 'Manual', CRM: 'CRM', CHAT: 'Chat', EMAIL: 'Email',
};
