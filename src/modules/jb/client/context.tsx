'use client';
// React context holds constants only (PERF-21, D-14): the store instances and the mode. Everything that
// changes is read through selectors on the stores, so a change re-renders only what selected it (D-15).
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { BoardStore } from './store';
import type { UiStore, UiState } from './ui-store';
import type { DemandStore } from './demand';

export interface BoardCtx {
  store: BoardStore;
  ui: UiStore;
  boardId: string;
  mode: 'collab' | 'share';
  me: { userId: string; name: string } | null;
  /** Image URLs (signed) for ids in view; share mode resolves through the share route. */
  imageUrl: (imageId: string) => string | undefined;
  requestImages: (ids: string[]) => void;
  announce: (message: string) => void;
  /** P5: the demand overlay store (collaborative mode only). */
  demand?: DemandStore;
  /** P5 (INT-45): send the outbox now, so a new card exists on the server before its panel reads it. */
  flush?: () => Promise<void>;
}

const Ctx = createContext<BoardCtx | null>(null);
export const BoardProvider = Ctx.Provider;
export function useBoard(): BoardCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useBoard outside BoardProvider');
  return c;
}

/** Selects from the board store; the component re-renders only when the selected value changes. */
export function useStoreSelect<T>(sel: (s: BoardStore) => T): T {
  const { store } = useBoard();
  return useSyncExternalStore(store.subscribe, () => sel(store), () => sel(store));
}
export function useUi<T>(sel: (s: UiState) => T): T {
  const { ui } = useBoard();
  return useSyncExternalStore(ui.subscribe, () => sel(ui.state), () => sel(ui.state));
}

/** Per-node selector (D-14): stable reference unless this node changed. */
export const useNodeRec = (id: string) => useStoreSelect((s) => s.view.nodes.get(id));
export const useReadOnly = () => useStoreSelect((s) => s.readOnly);
