'use client';

// Query keys, lookups and the paged ideas list (§4.3). Pages hold ids; rows live in the row store.
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import type { ViewSpecInput } from '@/modules/fh/columns';
import type { IdeaRow } from '@/modules/fh/rows';
import { api, specParam } from './api';
import { rowStore } from './rows';

export interface Feature { id: string; parentId: string | null; name: string; description: string | null; depth: number; sortOrder: number; openCount: number; allCount: number }
export interface Journey { id: string; name: string; syncedAt: string | null; ideaCount: number }
export interface Theme { id: string; name: string; colour: string | null; isSeeded: boolean; ideaCount: number }
export interface Milestone { id: string; name: string; date: string; colour: string | null; description: string | null; ideaCount: number }
export interface Owner { id: string; name: string }
export interface Lookups {
  features: Feature[]; journeys: Journey[]; themes: Theme[]; milestones: Milestone[]; owners: Owner[];
  settings: { currency: string; releaseTrain: { anchor: string; lengthDays: number }; planningYearStartMonth: number };
  access: { feedbackAdmin: boolean; canDeletePosts?: boolean; userId: string };
}

export const keys = {
  lookups: ['fh', 'lookups'] as const,
  ideas: (spec: ViewSpecInput) => ['fh', 'ideas', JSON.stringify(spec)] as const,
  ideasAll: ['fh', 'ideas'] as const,
  detail: (section: string, id: string) => ['fh', 'idea', section, id] as const,
  facets: (spec: ViewSpecInput, col: string, q: string) => ['fh', 'facets', JSON.stringify(spec), col, q] as const,
  board: (spec: ViewSpecInput, group: string) => ['fh', 'board', JSON.stringify(spec), group] as const,
  roadmap: (spec: ViewSpecInput, from: string, to: string) => ['fh', 'roadmap', JSON.stringify(spec), from, to] as const,
  savedViews: ['fh', 'saved-views'] as const,
};

export function useLookups() {
  return useQuery({ queryKey: keys.lookups, queryFn: () => api<Lookups>('/api/fh/lookups'), staleTime: 5 * 60_000 });
}

export interface IdsPage { ids: string[]; nextCursor: string | null; total?: number }

export function useIdeasList(spec: ViewSpecInput, enabled = true) {
  return useInfiniteQuery({
    queryKey: keys.ideas(spec),
    enabled,
    staleTime: 30_000,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const r = await api<{ rows: IdeaRow[]; nextCursor: string | null; total?: number }>(
        `/api/fh/ideas?${specParam(spec)}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`, { signal });
      rowStore.upsert(r.rows);
      return { ids: r.rows.map((x) => x.id), nextCursor: r.nextCursor, total: r.total } satisfies IdsPage;
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** PERF-01/PERF-10: a new row goes into the cache and the top of the current list; nothing is refetched. */
export function insertCreated(qc: QueryClient, spec: ViewSpecInput, row: IdeaRow) {
  rowStore.upsert([row]);
  qc.setQueryData<InfiniteData<IdsPage>>(keys.ideas(spec), (d) => {
    if (!d || !d.pages.length) return d;
    const [first, ...rest] = d.pages;
    return { ...d, pages: [{ ...first, ids: [row.id, ...first.ids.filter((x) => x !== row.id)], total: (first.total ?? 0) + 1 }, ...rest] };
  });
}

/** Removes ids from every loaded list (deleted or merged ideas). */
export function removeFromLists(qc: QueryClient, ids: string[]) {
  const gone = new Set(ids);
  qc.setQueriesData<InfiniteData<IdsPage>>({ queryKey: keys.ideasAll }, (d) => d && {
    ...d,
    pages: d.pages.map((p, i) => {
      const kept = p.ids.filter((x) => !gone.has(x));
      return { ...p, ids: kept, ...(i === 0 && p.total !== undefined && { total: Math.max(0, p.total - (p.ids.length - kept.length)) }) };
    }),
  });
  ids.forEach((id) => rowStore.remove(id));
}

export function useQc() { return useQueryClient(); }
