// Normalised idea row cache (§4.3: pages hold ids, rows hold data). Each table row subscribes to its own entry,
// so an edit re-renders one row, not the table (PERF-04, D-08). Pure enough to unit test without a DOM.
import { useSyncExternalStore } from 'react';
import type { IdeaRow } from '@/modules/fh/rows';

type Listener = () => void;

export class RowStore {
  private rows = new Map<string, IdeaRow>();
  private listeners = new Map<string, Set<Listener>>();
  private any = new Set<Listener>();

  get(id: string): IdeaRow | undefined { return this.rows.get(id); }

  /** Inserts or replaces rows. An older version never overwrites a newer one (late events, PERF-B17). */
  upsert(rows: IdeaRow[]): IdeaRow[] {
    const changed: IdeaRow[] = [];
    for (const r of rows) {
      const cur = this.rows.get(r.id);
      if (cur && (cur.version > r.version || cur === r)) continue;
      this.rows.set(r.id, r);
      changed.push(r);
    }
    for (const r of changed) this.listeners.get(r.id)?.forEach((l) => l());
    if (changed.length) this.any.forEach((l) => l());
    return changed;
  }

  /** Optimistic patch (PERF-08); returns the previous row so the caller can roll back. */
  patch(id: string, p: Partial<IdeaRow>): IdeaRow | undefined {
    const cur = this.rows.get(id);
    if (!cur) return undefined;
    this.rows.set(id, { ...cur, ...p });
    this.listeners.get(id)?.forEach((l) => l());
    this.any.forEach((l) => l());
    return cur;
  }

  restore(row: IdeaRow) {
    this.rows.set(row.id, row);
    this.listeners.get(row.id)?.forEach((l) => l());
    this.any.forEach((l) => l());
  }

  remove(id: string) {
    this.rows.delete(id);
    this.listeners.get(id)?.forEach((l) => l());
    this.any.forEach((l) => l());
  }

  subscribe(id: string, l: Listener) {
    let set = this.listeners.get(id);
    if (!set) { set = new Set(); this.listeners.set(id, set); }
    set.add(l);
    return () => { set!.delete(l); };
  }

  subscribeAll(l: Listener) { this.any.add(l); return () => { this.any.delete(l); }; }
}

export const rowStore = new RowStore();

export function useRow(id: string): IdeaRow | undefined {
  return useSyncExternalStore((l) => rowStore.subscribe(id, l), () => rowStore.get(id), () => rowStore.get(id));
}
