// P5 client: colour scale (INT-35), legend (INT-37), target date (INT-39) and the D-27 client delivery path:
// a demand revision seen on the 1 s changes poll refetches the overlay, so an attention flag reaches the card.
import { describe, expect, it } from 'vitest';
import { BoardStore } from '@/modules/jb/client/store';
import { BoardSync } from '@/modules/jb/client/sync';
import { DemandStore, demandColour, demandPosition, formatTarget, legendValues, type DemandView } from '@/modules/jb/client/demand';
import { POLL_VISIBLE_MS } from '@/modules/jb/client/live';
import { UiStore } from '@/modules/jb/client/ui-store';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('colour scale and legend (INT-35 to INT-37, INT-39)', () => {
  it('uses a square-root position relative to the busiest card, dark blue at zero, red at the max', () => {
    expect(demandPosition(0, 10)).toBe(0);
    expect(demandPosition(5, 0)).toBe(0);
    expect(demandPosition(25, 100)).toBe(0.5);
    expect(demandPosition(200, 100)).toBe(1);
    expect(demandColour(0, 40)).toBe('rgb(30, 58, 138)');
    expect(demandColour(40, 40)).toBe('rgb(220, 38, 38)');
    expect(demandColour(10, 40)).toBe('rgb(250, 204, 21)'); // p = 0.5
    expect(demandColour(10, 40, 0.55)).toBe('rgba(250, 204, 21, 0.55)');
  });
  it('legend: 0 and the distinct values of {1, max/4, max/2, max}', () => {
    expect(legendValues(0)).toEqual([0]);
    expect(legendValues(1)).toEqual([0, 1]);
    expect(legendValues(2)).toEqual([0, 1, 2]);
    expect(legendValues(40)).toEqual([0, 1, 10, 20, 40]);
  });
  it('formats the target as a calendar date with no time zone shift', () => {
    expect(formatTarget('2026-11-30')).toBe('30 Nov 2026');
    expect(formatTarget(null)).toBe('Nothing planned with a date');
  });
});

describe('D-27 client delivery: the changes poll carries the demand revision', () => {
  it('a moved revision refetches the overlay and the attention flag reaches the UI store within one poll', async () => {
    const ui = new UiStore();
    let rev = 3;
    let attention: Record<string, unknown> = {};
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url.includes('/overlay')) return json({ available: true, scope: 'open', demandRev: rev, counts: { q1: 2 }, releaseDates: { q1: null }, attention });
      return json({ seq: 0, batches: [], more: false, demandRev: rev });
    }) as unknown as typeof fetch;
    const demand = new DemandStore({ boardId: 'B', userId: 'u', fetch: fetchImpl, onChange: (v) => ui.set({ demand: v }) });
    const store = new BoardStore('me');
    store.load({ seq: 0, name: 'B', settings: {}, nodes: [], edges: [], fields: [] } as never);
    const sync = new BoardSync(store, { boardId: 'B', fetch: fetchImpl, newId: () => 'x', loadContent: async () => { throw new Error('no'); }, onDemandRev: (r) => demand.onRev(r) });

    demand.setEnabled(true);
    await demand.idle();
    expect(ui.state.demand).toMatchObject({ available: true, counts: { q1: 2 }, max: 2 });
    const overlayCalls = () => urls.filter((u) => u.includes('/overlay')).length;
    const before = overlayCalls();

    await sync.pull(); // same revision: no refetch on unrelated polls (INT-33)
    expect(overlayCalls()).toBe(before);

    // A Feature is deleted in Feedback Hub: jb.demand.notify bumps the board's revision.
    rev = 4; attention = { q1: [{ relation: 'maps-to-feature', toId: 'f' }] };
    await sync.pull();   // the next 1 s poll (POLL_VISIBLE_MS)
    await demand.idle();  // the refetch the poll started
    expect(overlayCalls()).toBe(before + 1);
    expect((ui.state.demand as DemandView).attention).toEqual({ q1: [{ relation: 'maps-to-feature', toId: 'f' }] });
    expect(POLL_VISIBLE_MS).toBeLessThanOrEqual(1000);
  });

  it('remembers scope and on/off per user per board and refetches on scope change', async () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => { urls.push(url); return json({ available: true, counts: {}, releaseDates: {}, attention: {} }); }) as unknown as typeof fetch;
    const a = new DemandStore({ boardId: 'B', userId: 'u', fetch: fetchImpl, onChange: () => {}, storage });
    a.setEnabled(true);
    a.setScope('all'); a.setOn(false);
    await a.refresh();
    expect(urls.some((u) => u.endsWith('scope=all'))).toBe(true);
    const b = new DemandStore({ boardId: 'B', userId: 'u', fetch: fetchImpl, onChange: () => {}, storage });
    expect([b.view.scope, b.view.on]).toEqual(['all', false]);
    const other = new DemandStore({ boardId: 'C', userId: 'u', fetch: fetchImpl, onChange: () => {}, storage });
    expect([other.view.scope, other.view.on]).toEqual(['open', true]);
  });

  it('does not request the overlay on a board without Product cards', async () => {
    const urls: string[] = [];
    const d = new DemandStore({ boardId: 'B', userId: 'u', fetch: (async (u: string) => { urls.push(u); return json({}); }) as unknown as typeof fetch, onChange: () => {} });
    await d.refresh();
    d.onRev(1); d.onRev(2);
    expect(urls).toEqual([]);
  });
});
