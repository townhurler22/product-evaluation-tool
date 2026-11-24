// Client-side regression tests for SPEC §14 rows that live in the browser code: D-01, D-02, D-08, D-09, D-32,
// D-33, D-38. The browser modules are pure enough to run without a DOM.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { IdeaRow } from '@/modules/fh/rows';
import { insertCreated, keys, removeFromLists, type IdsPage } from '@/app/fh/_lib/data';
import { RowStore, rowStore } from '@/app/fh/_lib/rows';
import { chunk, pruneSelection, runChunks, selectionScope } from '@/app/fh/_lib/selection';
import { domRowsFor, OVERSCAN, ROW_HEIGHT } from '@/app/fh/_lib/table-config';
import { BULK_CHUNK } from '@/modules/fh/domain';

const row = (id: string, version = 1, extra: Partial<IdeaRow> = {}): IdeaRow => ({
  id, number: 1, title: 't', ideaType: 'FEATURE_REQUEST', status: 'OPEN', bugStatus: null, featureId: null, milestoneId: null,
  ownerId: null, startDate: null, dueDate: null, estimateDays: null, strategicValue: null, revenueImpact: null,
  customerExperience: null, riskScore: null, effortScore: null, isDealbreaker: false, isCommitted: false, unreviewed: false,
  version, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', userCount: 0, companyCount: 0, arr: '0.00',
  insightCount: 0, voteTotal: 0, distinctVoters: 0, sources: [], hasIntakeSource: false, onForum: false, companyMissing: false,
  themeIds: [], journeyIds: [], companies: [], topMatch: null, ...extra,
});

describe('D-01 / D-02: create updates only the affected cache entries', () => {
  it('puts the new row in the row cache and at the top of the current list, with no refetch', async () => {
    const qc = new QueryClient();
    const spec = { view: 'all' as const };
    const fetcher = vi.fn();
    qc.setQueryDefaults(keys.ideasAll, { queryFn: fetcher });
    qc.setQueryData<InfiniteData<IdsPage>>(keys.ideas(spec), { pages: [{ ids: ['a', 'b'], nextCursor: 'c', total: 2 }], pageParams: [null] });
    const lookupsBefore = qc.getQueryState(keys.lookups);
    insertCreated(qc, spec, row('new'));
    const data = qc.getQueryData<InfiniteData<IdsPage>>(keys.ideas(spec))!;
    expect(data.pages[0]).toEqual({ ids: ['new', 'a', 'b'], nextCursor: 'c', total: 3 });
    expect(rowStore.get('new')?.id).toBe('new'); // the panel paints from this at once (PERF-B02)
    expect(fetcher).not.toHaveBeenCalled();
    expect(qc.getQueryState(keys.lookups)).toEqual(lookupsBefore);
    expect(qc.isFetching()).toBe(0);
  });
});

describe('D-09: cached rows are updated by events, not refetched', () => {
  it('a newer version replaces a row, an older one is ignored, and only that row is notified', () => {
    const s = new RowStore();
    s.upsert([row('x', 2), row('y', 1)]);
    const onX = vi.fn(), onY = vi.fn();
    s.subscribe('x', onX); s.subscribe('y', onY);
    s.upsert([row('x', 1, { title: 'stale' })]);
    expect(s.get('x')!.version).toBe(2);
    expect(onX).not.toHaveBeenCalled();
    s.upsert([row('x', 3, { title: 'fresh' })]);
    expect(s.get('x')!.title).toBe('fresh');
    expect(onX).toHaveBeenCalledTimes(1);
    expect(onY).not.toHaveBeenCalled();
  });

  it('optimistic edits roll back exactly (PERF-08)', () => {
    const s = new RowStore();
    s.upsert([row('x', 1, { title: 'before' })]);
    const prev = s.patch('x', { title: 'after' })!;
    expect(s.get('x')!.title).toBe('after');
    s.restore(prev);
    expect(s.get('x')!.title).toBe('before');
  });

  it('removed ideas leave every loaded list and the totals drop', () => {
    const qc = new QueryClient();
    qc.setQueryData<InfiniteData<IdsPage>>(keys.ideas({ view: 'all' }), { pages: [{ ids: ['a', 'b'], nextCursor: null, total: 2 }], pageParams: [null] });
    qc.setQueryData<InfiniteData<IdsPage>>(keys.ideas({ view: 'triage' }), { pages: [{ ids: ['b'], nextCursor: null, total: 1 }], pageParams: [null] });
    removeFromLists(qc, ['b']);
    expect(qc.getQueryData<InfiniteData<IdsPage>>(keys.ideas({ view: 'all' }))!.pages[0]).toEqual({ ids: ['a'], nextCursor: null, total: 1 });
    expect(qc.getQueryData<InfiniteData<IdsPage>>(keys.ideas({ view: 'triage' }))!.pages[0].ids).toEqual([]);
  });
});

describe('D-08: the table is virtualised with one shared editor', () => {
  it('keeps at most ~60 rows plus overscan in the DOM, even on a tall screen (PERF-B06: ≤ 100)', () => {
    expect(domRowsFor(1080)).toBeLessThanOrEqual(100);
    expect(domRowsFor(1440)).toBeLessThanOrEqual(100);
    expect(ROW_HEIGHT * 60).toBeGreaterThanOrEqual(1080);
    expect(OVERSCAN).toBeLessThanOrEqual(20);
  });

  it('renders no option list per cell: editors and option lists live only in the shared editor', () => {
    const table = readFileSync(join(process.cwd(), 'src/app/fh/_components/ideas-table.tsx'), 'utf8');
    const cells = readFileSync(join(process.cwd(), 'src/app/fh/_components/cells.tsx'), 'utf8');
    expect(table).toContain('useVirtualizer');
    expect(table.match(/<CellEditor/g)).toHaveLength(1);
    expect(cells).not.toMatch(/<select|<option|role="listbox"/);
    expect(table).toMatch(/memo\(function Row/);
  });
});

describe('D-32: selection is pruned to what the user can see', () => {
  it('drops selected ids that a filter, rail choice or search hid', () => {
    expect([...pruneSelection(new Set(['a', 'b', 'c']), ['a', 'c', 'd'])]).toEqual(['a', 'c']);
  });
  it('changing view, search or rail changes the scope (which clears the selection)', () => {
    const base = selectionScope({ view: 'all', search: '', rail: {} });
    expect(selectionScope({ view: 'triage', search: '', rail: {} })).not.toBe(base);
    expect(selectionScope({ view: 'all', search: 'x', rail: {} })).not.toBe(base);
    expect(selectionScope({ view: 'all', search: ' ', rail: {} })).toBe(base);
    expect(selectionScope({ view: 'all', search: '', rail: { featureId: 'f' } })).not.toBe(base);
  });
});

describe('D-33: bulk actions go in server-cap chunks with progress', () => {
  it('sends 1,200 ids as six chunks of 200, one after another', async () => {
    const ids = Array.from({ length: 1200 }, (_, i) => `id${i}`);
    const sent: number[] = [];
    const progress: string[] = [];
    let inFlight = 0, maxInFlight = 0;
    const res = await runChunks(ids, async (c) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      sent.push(c.length); inFlight--;
      return c.length;
    }, (p) => progress.push(`${p.done}/${p.total}`));
    expect(sent).toEqual([200, 200, 200, 200, 200, 200]);
    expect(maxInFlight).toBe(1);
    expect(progress).toEqual(['0/1200', '200/1200', '400/1200', '600/1200', '800/1200', '1000/1200', '1200/1200']);
    expect(res).toMatchObject({ done: 1200, total: 1200, error: null });
    expect(chunk(ids).every((c) => c.length <= BULK_CHUNK)).toBe(true);
  });

  it('stops at the first failure and reports how far it got', async () => {
    const ids = Array.from({ length: 1200 }, (_, i) => `id${i}`);
    let n = 0;
    const res = await runChunks(ids, async () => { if (++n === 3) throw new Error('Server busy'); return n; }, () => {});
    expect(res.done).toBe(400);
    expect(res.error?.message).toBe('Server busy');
    expect(res.results).toHaveLength(2);
  });
});

describe('D-38: the rail lists scroll in their own areas and rows keep their height', () => {
  it('each list has its own scroll container; rows have a fixed height and never shrink', () => {
    const rail = readFileSync(join(process.cwd(), 'src/app/fh/_components/rail.tsx'), 'utf8');
    const lists = [...rail.matchAll(/<ul className="([^"]+)"[^>]*aria-label="(Features|Journeys)"/g)];
    expect(lists.map((m) => m[2])).toEqual(['Features', 'Journeys']);
    for (const m of lists) expect(m[1]).toMatch(/overflow-y-auto/);
    expect(rail).toMatch(/const rowCls = [^\n]*flex h-8 shrink-0/);
    expect(rail).toMatch(/truncate[^\n]*title=\{f\.name\}/);
  });
});
