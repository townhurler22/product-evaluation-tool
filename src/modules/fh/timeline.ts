// Roadmap timeline geometry (FH-762–766). Pure: UTC calendar days, inclusive bars, shared by the Gantt and tests.
import { addDays, daysBetween } from './domain';

export const ZOOMS = { '2w': 14, '8w': 56, '6m': 182, '1y': 365 } as const;
export type Zoom = keyof typeof ZOOMS;
export const ZOOM_LABEL: Record<Zoom, string> = { '2w': '2 weeks', '8w': '8 weeks', '6m': '6 months', '1y': '1 year' };

/** FH-762: short zooms open 3 days before today; 6 months on the first of the current month (OD-15); 1 year on the planning year start. */
export function initialWindowStart(zoom: Zoom, today: string, planningStartMonth: number): string {
  if (zoom === '2w' || zoom === '8w') return addDays(today, -3);
  const [y, m] = today.split('-').map(Number);
  if (zoom === '6m') return `${y}-${String(m).padStart(2, '0')}-01`;
  const year = m >= planningStartMonth ? y : y - 1;
  return `${year}-${String(planningStartMonth).padStart(2, '0')}-01`;
}

/** FH-763: pan by a quarter of the visible span. */
export const panStep = (zoom: Zoom) => Math.round(ZOOMS[zoom] / 4);

export interface Bar { left: number; width: number; clippedStart: boolean; clippedEnd: boolean }

/** FH-765: inclusive bars (start = due is one day); clipped bars are shortened and marked; bars fully outside return null. */
export function barGeometry(start: string, due: string | null, from: string, days: number, dayWidth: number): Bar | null {
  const end = due ?? start;
  const s = daysBetween(from, start);
  const e = daysBetween(from, end) + 1; // exclusive end
  if (e <= 0 || s >= days) return null;
  const cs = Math.max(0, s), ce = Math.min(days, e);
  return { left: cs * dayWidth, width: Math.max(1, (ce - cs) * dayWidth), clippedStart: s < 0, clippedEnd: e > days };
}

/** FH-766: drags snap to days, or to 7-day steps when one day is narrower than 3 px. */
export function snapDays(pixels: number, dayWidth: number): number {
  const raw = pixels / dayWidth;
  return dayWidth < 3 ? Math.round(raw / 7) * 7 : Math.round(raw);
}

/** Tick dates for the axis: days, weeks (Mondays) or month starts. */
export function ticks(zoom: Zoom, from: string): string[] {
  const days = ZOOMS[zoom];
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (zoom === '2w' || (zoom === '8w' && dow === 1) || ((zoom === '6m' || zoom === '1y') && d.endsWith('-01'))) out.push(d);
  }
  return out;
}
