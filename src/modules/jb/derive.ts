// Derived layers (§8.6, §8.8, §8.10, §8.11). Pure; computed on the client, never stored in node data.
import { getKind, readDesignCard, type DesignCardView } from './kinds';
import type { FieldRec, NodeRec } from './ops';

export const STATUS_FIELD_ID = 'status';
export const STATUS_OPTIONS = [
  { id: 'not-assessed', label: 'Not assessed', colour: 'gray' },
  { id: 'redesign', label: 'Redesign planned', colour: 'amber' },
  { id: 'current', label: 'Current design', colour: 'green' },
  { id: 'legacy', label: 'Legacy', colour: 'violet' },
  { id: 'deprecated', label: 'Deprecated', colour: 'rose' },
] as const;
export const FIELD_COLOURS = ['gray', 'blue', 'violet', 'green', 'amber', 'rose', 'cyan', 'lime', 'orange', 'teal'] as const;

/** Nominal sizes used for geometry (section membership, keyboard focus moves, fit). */
export function nodeSize(n: NodeRec): { w: number; h: number } {
  if (n.width && n.height) return { w: n.width, h: n.height };
  const def = getKind(n.kind);
  if (def?.size) return { w: def.size.width, h: def.size.height };
  if (n.kind === 'design-card') return (n.data as { cardSize?: string }).cardSize === 'large' ? { w: 320, h: 180 } : { w: 240, h: 120 };
  if (n.kind === 'product-card') return { w: 240, h: 120 };
  if (n.kind === 'text') return { w: 200, h: 48 };
  if (n.kind === 'stats') return { w: 260, h: 180 };
  return { w: 200, h: 100 };
}

// ── calendar dates (JB-903): bare YYYY-MM-DD, never through local time zones ──
export function dayNumber(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86_400_000);
}
export const todayNumber = (now: Date) => Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000);
const isoDayNumber = (iso: string | null) => (iso ? Math.floor(Date.parse(iso) / 86_400_000) : null);

// ── freshness (JB-1101) ─────────────────────────────────────────────────────
export type Freshness = 'fresh' | 'aging' | 'stale' | 'never';
export interface Thresholds { agingDays: number; staleDays: number }
export function readThresholds(settings: Record<string, unknown>): Thresholds {
  const h = (settings.health ?? {}) as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === 'number' && v > 0 && v < 10_000 ? v : d);
  return { agingDays: n(h.agingDays, 30), staleDays: n(h.staleDays, 90) };
}
export function freshness(c: DesignCardView, now: Date, t: Thresholds): Freshness {
  const ref = isoDayNumber(c.reviewedAt) ?? isoDayNumber(c.updatedAt);
  if (ref === null || Number.isNaN(ref)) return 'never';
  const days = todayNumber(now) - ref;
  if (days >= t.staleDays) return 'stale';
  if (days >= t.agingDays) return 'aging';
  return 'fresh';
}

// ── hierarchy (§8.8), maintained incrementally by the store; these helpers work on one node ──
export function effectiveArea(id: string, byId: (id: string) => NodeRec | undefined): string {
  const seen = new Set<string>();
  let cur = byId(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const d = readDesignCard(cur.data);
    if (d.area) return d.area;
    cur = d.parentId ? byId(d.parentId) : undefined;
  }
  return '';
}

/** True if making `parentId` the parent of `id` would create a cycle (INV-20, JB-803). */
export function wouldCycle(id: string, parentId: string | null, byId: (id: string) => NodeRec | undefined): boolean {
  let cur = parentId; let depth = 0;
  while (cur && depth++ < 64) {
    if (cur === id) return true;
    const n = byId(cur);
    cur = n ? readDesignCard(n.data).parentId : null;
  }
  return depth > 64;
}

// ── board health (JB-1102) ──────────────────────────────────────────────────
export interface HealthRows { stale: string[]; never: string[]; noOwner: string[]; notAssessed: string[] | null; noLinks: string[] }
export function boardHealth(cards: NodeRec[], statusField: FieldRec | undefined, now: Date, t: Thresholds): HealthRows {
  const hasNotAssessed = statusField?.options.some((o) => o.id === 'not-assessed') ?? false;
  const rows: HealthRows = { stale: [], never: [], noOwner: [], notAssessed: hasNotAssessed ? [] : null, noLinks: [] };
  for (const n of cards) {
    if (n.kind !== 'design-card') continue;
    const c = readDesignCard(n.data);
    const f = freshness(c, now, t);
    if (f === 'stale') rows.stale.push(n.id);
    if (!c.reviewedAt) rows.never.push(n.id);
    if (!c.owner) rows.noOwner.push(n.id);
    const status = c.fieldValues[STATUS_FIELD_ID];
    if (rows.notAssessed && (!status || status === 'not-assessed')) rows.notAssessed.push(n.id);
    if (!c.links.length && !c.currentVersion.designUrl && !c.currentVersion.prototypeUrl && !c.currentVersion.docUrl) rows.noLinks.push(n.id);
  }
  return rows;
}

// ── lookahead and readiness (JB-1103) ───────────────────────────────────────
export type LookaheadBucket = 'overdue' | 'this-week' | 'next-week' | 'soon' | 'later' | 'none';
export const LOOKAHEAD_LABELS: Record<LookaheadBucket, string> = {
  overdue: 'Overdue', 'this-week': 'This week', 'next-week': 'Next week', soon: 'Soon', later: 'Later', none: 'No date',
};
export function lookahead(date: unknown, today: number, horizonWeeks: number): LookaheadBucket {
  const d = typeof date === 'string' ? dayNumber(date) : null;
  if (d === null) return 'none';
  const days = d - today;
  if (days < 0) return 'overdue';
  if (days <= 6) return 'this-week';
  if (days <= 13) return 'next-week';
  if (days <= horizonWeeks * 7) return 'soon';
  return 'later';
}
export type Readiness = 'none' | 'overdue' | 'at-risk' | 'ready';
export function readiness(c: DesignCardView, dateFieldId: string | null, today: number, horizonWeeks: number): Readiness {
  const raw = dateFieldId ? c.fieldValues[dateFieldId] : null;
  const d = typeof raw === 'string' ? dayNumber(raw) : null;
  if (d === null) return 'none';
  const status = String(c.fieldValues[STATUS_FIELD_ID] ?? '');
  if (d < today && status !== 'current' && status !== 'deprecated') return 'overdue';
  if (d - today <= horizonWeeks * 7 && (!c.owner || ['not-assessed', 'legacy', 'redesign', ''].includes(status))) return 'at-risk';
  return 'ready';
}

// ── filters (JB-1001, JB-1002): Design cards only; OR within a field, AND across fields ──
export interface Filters {
  options: Record<string, string[]>; // fieldId → option ids
  owners: string[];
  freshness: Freshness[];
  missingOwner: boolean;
  text: string;
}
export const emptyFilters = (): Filters => ({ options: {}, owners: [], freshness: [], missingOwner: false, text: '' });
export const filtersActive = (f: Filters) =>
  Object.values(f.options).some((v) => v.length) || f.owners.length > 0 || f.freshness.length > 0 || f.missingOwner || f.text.trim() !== '';

export function matchesFilters(n: NodeRec, f: Filters, now: Date, t: Thresholds): boolean {
  if (n.kind !== 'design-card') return true; // filters never judge other kinds
  const c = readDesignCard(n.data);
  for (const [fieldId, ids] of Object.entries(f.options)) {
    if (ids.length && !ids.includes(String(c.fieldValues[fieldId] ?? ''))) return false;
  }
  if (f.owners.length && !f.owners.includes(c.owner)) return false;
  if (f.freshness.length && !f.freshness.includes(freshness(c, now, t))) return false;
  if (f.missingOwner && c.owner) return false;
  const q = f.text.trim().toLowerCase();
  if (q && !`${c.title} ${c.area} ${c.versionTag} ${c.team}`.toLowerCase().includes(q)) return false;
  return true;
}

// ── sections (JB-601): geometric membership ─────────────────────────────────
export function insideSection(n: NodeRec, s: NodeRec): boolean {
  if (n.id === s.id) return false;
  const a = nodeSize(n), b = nodeSize(s);
  return n.x >= s.x && n.y >= s.y && n.x + a.w <= s.x + b.w && n.y + a.h <= s.y + b.h;
}

// ── statistics widget (JB-603) ──────────────────────────────────────────────
export interface StatsResult { total: number; rows: { optionId: string; label: string; colour: string; count: number }[]; goalPct: number | null; goalLabel: string }
export function computeStats(
  cards: NodeRec[], field: FieldRec | undefined, goalOptionId: string, excluded: string[],
): StatsResult {
  const rows = (field?.options ?? []).filter((o) => !excluded.includes(o.id)).map((o) => ({ optionId: o.id, label: o.label, colour: o.colour, count: 0 }));
  const idx = new Map(rows.map((r, i) => [r.optionId, i]));
  let total = 0;
  for (const n of cards) {
    if (n.kind !== 'design-card') continue;
    const c = readDesignCard(n.data);
    if (c.excludeFromStats) continue;
    const v = field ? c.fieldValues[field.id] : undefined;
    if (typeof v !== 'string' || !v || excluded.includes(v)) continue;
    const i = idx.get(v);
    if (i === undefined) continue;
    rows[i].count++; total++;
  }
  const goal = rows.find((r) => r.optionId === goalOptionId);
  return { total, rows, goalPct: total && goal ? Math.round((goal.count / total) * 100) : null, goalLabel: goal?.label ?? '' };
}
