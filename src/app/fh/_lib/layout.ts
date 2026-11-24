// Column layout per user per view in local storage under a versioned key (FH-111). Pure reconcile + safe storage.
import { COLUMNS, COLUMN_BY_ID, MIN_COLUMN_WIDTH } from '@/modules/fh/columns';
import type { View } from '@/modules/fh/domain';

export interface Layout { order: string[]; hidden: string[]; widths: Record<string, number>; sort: { column: string; dir: 'asc' | 'desc' } | null }

const DEFAULT_HIDDEN = ['strategicValue', 'revenueImpact', 'customerExperience', 'riskScore', 'effortScore', 'estimateDays', 'updatedAt', 'journeys', 'companyCount', 'insights'];

export const defaultLayout = (): Layout => ({ order: COLUMNS.map((c) => c.id), hidden: [...DEFAULT_HIDDEN], widths: {}, sort: null });

/** Unknown columns dropped; new columns inserted after their canonical predecessor and visible by default. */
export function reconcileLayout(saved: Partial<Layout> | null | undefined): Layout {
  const base = defaultLayout();
  if (!saved || !Array.isArray(saved.order)) return base;
  const order = saved.order.filter((id) => typeof id === 'string' && COLUMN_BY_ID[id]);
  const seen = new Set(order);
  COLUMNS.forEach((c, i) => {
    if (seen.has(c.id)) return;
    let at = 0;
    for (let k = i - 1; k >= 0; k--) {
      const idx = order.indexOf(COLUMNS[k].id);
      if (idx >= 0) { at = idx + 1; break; }
    }
    order.splice(at, 0, c.id);
    seen.add(c.id);
  });
  if (!order.includes('title')) order.unshift('title');
  const hidden = Array.isArray(saved.hidden) ? saved.hidden.filter((id) => COLUMN_BY_ID[id] && id !== 'title') : [];
  const widths: Record<string, number> = {};
  for (const [k, v] of Object.entries(saved.widths ?? {})) {
    if (COLUMN_BY_ID[k] && typeof v === 'number' && Number.isFinite(v)) widths[k] = Math.max(MIN_COLUMN_WIDTH, Math.min(1200, Math.round(v)));
  }
  const sort = saved.sort && COLUMN_BY_ID[saved.sort.column]?.sort && (saved.sort.dir === 'asc' || saved.sort.dir === 'desc') ? saved.sort : null;
  return { order, hidden, widths, sort };
}

const key = (userId: string, view: View) => `pet.fh.layout.v1.${userId}.${view}`;

export function loadLayout(userId: string, view: View): Layout {
  try {
    const raw = window.localStorage.getItem(key(userId, view));
    return reconcileLayout(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultLayout();
  }
}

export function saveLayout(userId: string, view: View, l: Layout) {
  try { window.localStorage.setItem(key(userId, view), JSON.stringify(l)); } catch { /* storage blocked: layout lasts this visit */ }
}

export const widthOf = (l: Layout, id: string) => l.widths[id] ?? COLUMN_BY_ID[id]?.width ?? 120;

/** Cycle asc → desc → off (FH-110). */
export function nextSort(cur: Layout['sort'], column: string): Layout['sort'] {
  if (!cur || cur.column !== column) return { column, dir: 'asc' };
  if (cur.dir === 'asc') return { column, dir: 'desc' };
  return null;
}
