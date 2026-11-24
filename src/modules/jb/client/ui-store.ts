// Transient, per-user UI state (PERF-21): selection for the panel, dimmed and highlighted ids, filters,
// isolate mode, comments. Never persisted to the board. Read through per-node selectors.
import { emptyFilters, type Filters } from '../derive';

type Listener = () => void;

export interface UiState {
  panelNodeId: string | null;
  panelEdgeId: string | null;
  selection: readonly string[];
  deletedNotice: string | null;      // JB-1504
  dimmed: ReadonlySet<string>;
  highlighted: string | null;
  filters: Filters;
  isolate: { label: string; ids: string[]; index: number } | null;
  commentCounts: ReadonlyMap<string, number>;
  live: 'realtime' | 'polling' | 'offline';
}

export class UiStore {
  state: UiState = {
    panelNodeId: null, panelEdgeId: null, selection: [], deletedNotice: null, dimmed: new Set(), highlighted: null, filters: emptyFilters(),
    isolate: null, commentCounts: new Map(), live: 'polling',
  };
  private listeners = new Set<Listener>();
  subscribe = (l: Listener) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  set(patch: Partial<UiState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
  /** Replaces the dimmed set only when its contents change, so unchanged cards keep their selector values. */
  setDimmed(ids: Set<string>) {
    const cur = this.state.dimmed;
    if (cur.size === ids.size && [...ids].every((i) => cur.has(i))) return;
    this.set({ dimmed: ids });
  }
}
