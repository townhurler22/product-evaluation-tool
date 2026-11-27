// Demand overlay state for one board (§9.7, INT-33 to INT-39, PERF-31). Framework-free and unit-tested.
// One request per board in view; refetched on scope change, on the viewer's own link, unlink or sync, and when the
// board's demand revision moves: from `demand.changed` (realtime) or from the `changes?since=` poll (D-27).
// Never refetched on unrelated board edits.

export type Scope = 'open' | 'all';
export type Attention = { relation: 'maps-to-feature' | 'maps-to-journey'; toId: string }[];

export interface DemandView {
  available: boolean;
  scope: Scope;
  /** Bands and counts shown (INT-37); release dates and attention flags show either way (INT-29, INT-39). */
  on: boolean;
  counts: Readonly<Record<string, number>>;
  releaseDates: Readonly<Record<string, string | null>>;
  attention: Readonly<Record<string, Attention>>;
  /** The busiest card on the board in view (INT-34). */
  max: number;
  rev: number;
}

export interface DemandDeps {
  boardId: string;
  userId: string;
  fetch: typeof fetch;
  onChange: (v: DemandView) => void;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

const STOPS: [number, [number, number, number]][] = [
  [0, [30, 58, 138]], [0.25, [96, 165, 250]], [0.5, [250, 204, 21]], [0.75, [249, 115, 22]], [1, [220, 38, 38]],
];

/** INT-35: p = sqrt(min(count, max) / max), 0 when count ≤ 0 or max ≤ 0. */
export function demandPosition(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.sqrt(Math.min(count, max) / max);
}

/** INT-35: linear RGB blend between the neighbouring stops. */
export function demandRgb(count: number, max: number): [number, number, number] {
  const p = demandPosition(count, max);
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, c1] = STOPS[i];
    if (p <= p1) {
      const [p0, c0] = STOPS[i - 1];
      const t = (p - p0) / (p1 - p0);
      return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * t)) as [number, number, number];
    }
  }
  return [220, 38, 38];
}

export function demandColour(count: number, max: number, alpha = 1): string {
  const [r, g, b] = demandRgb(count, max);
  return alpha === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Labels for breakdown keys: `FEATURE_REQUEST` → "Feature request", `bug:IN_DEV` → "Bug: in dev". */
export function demandLabel(key: string): string {
  const human = (s: string) => { const t = s.toLowerCase().replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
  return key.startsWith('bug:') ? `Bug: ${human(key.slice(4)).toLowerCase()}` : human(key);
}

/** INT-37: swatches for 0 and the distinct values of {1, round(max/4), round(max/2), max}. */
export function legendValues(max: number): number[] {
  if (max <= 0) return [0];
  return [0, ...[...new Set([1, Math.round(max / 4), Math.round(max / 2), max])].filter((v) => v >= 1 && v <= max).sort((a, b) => a - b)];
}

/** INT-39: a calendar date with no time zone shift, e.g. "30 Nov 2026". */
export function formatTarget(date: string | null): string {
  if (!date) return 'Nothing planned with a date';
  const [y, m, d] = date.split('-').map(Number);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return `${d} ${month} ${y}`;
}

const prefKey = (userId: string, boardId: string) => `pet.jb.overlay.${userId}.${boardId}`;

export class DemandStore {
  view: DemandView = { available: false, scope: 'open', on: true, counts: {}, releaseDates: {}, attention: {}, max: 0, rev: 0 };
  private lastRev: number | null = null;
  private inflight: Promise<void> | null = null;
  private again = false;
  private enabled = false;
  private breakdowns = new Map<string, Promise<unknown>>();

  constructor(private readonly d: DemandDeps) {
    // INT-37: scope and on/off are remembered per user per board.
    try {
      const raw = d.storage?.getItem(prefKey(d.userId, d.boardId));
      const p = raw ? JSON.parse(raw) as { scope?: Scope; on?: boolean } : null;
      if (p?.scope === 'all' || p?.scope === 'open') this.view = { ...this.view, scope: p.scope };
      if (typeof p?.on === 'boolean') this.view = { ...this.view, on: p.on };
    } catch { /* private mode: defaults */ }
  }

  private savePrefs() {
    try { this.d.storage?.setItem(prefKey(this.d.userId, this.d.boardId), JSON.stringify({ scope: this.view.scope, on: this.view.on })); } catch { /* ignore */ }
  }

  private set(patch: Partial<DemandView>) {
    this.view = { ...this.view, ...patch };
    this.d.onChange(this.view);
  }

  /** INT-33: the overlay is requested only while the board has at least one Product card. */
  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) void this.refresh();
  }

  setScope(scope: Scope) {
    if (scope === this.view.scope) return;
    this.set({ scope });
    this.breakdowns.clear();
    this.savePrefs();
    void this.refresh();
  }

  setOn(on: boolean) { this.set({ on }); this.savePrefs(); }

  /** A demand revision seen on the changes poll or a `demand.changed` event. Refetches only when it moves. */
  onRev(rev: number | undefined) {
    if (typeof rev !== 'number') return;
    if (this.lastRev === null) { this.lastRev = rev; return; }
    if (rev === this.lastRev) return;
    this.lastRev = rev;
    void this.refresh();
  }

  /** Resolves when no overlay request is in flight (tests, and callers that want the fresh view). */
  idle(): Promise<void> { return this.inflight ?? Promise.resolve(); }

  /** One request; overlapping calls coalesce into one more fetch after the current one. */
  refresh(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.inflight) { this.again = true; return this.inflight; }
    this.inflight = (async () => {
      try {
        do {
          this.again = false;
          const scope = this.view.scope;
          const res = await this.d.fetch(`/api/jb/boards/${this.d.boardId}/overlay?scope=${scope}`);
          if (!res.ok) return;
          const body = await res.json() as { available: boolean; demandRev?: number; counts?: Record<string, number>; releaseDates?: Record<string, string | null>; attention?: Record<string, Attention> };
          if (typeof body.demandRev === 'number') this.lastRev = Math.max(this.lastRev ?? 0, body.demandRev);
          this.breakdowns.clear();
          if (!body.available) { this.set({ available: false, counts: {}, releaseDates: {}, attention: {}, max: 0, rev: this.view.rev + 1 }); continue; }
          const counts = body.counts ?? {};
          this.set({
            available: true, counts, releaseDates: body.releaseDates ?? {}, attention: body.attention ?? {},
            max: Math.max(0, ...Object.values(counts)), rev: this.view.rev + 1,
          });
        } while (this.again);
      } catch { /* offline: the next revision or reconnect refetches */ } finally { this.inflight = null; }
    })();
    return this.inflight;
  }

  /** INT-41: loaded once per card and scope until the next overlay refresh. */
  breakdown(nodeId: string): Promise<unknown> {
    const key = `${this.view.scope}:${nodeId}`;
    let p = this.breakdowns.get(key);
    if (!p) {
      p = this.d.fetch(`/api/jb/boards/${this.d.boardId}/nodes/${encodeURIComponent(nodeId)}/breakdown?scope=${this.view.scope}`)
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      this.breakdowns.set(key, p);
    }
    return p;
  }
}
