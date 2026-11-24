// Client store and sync engine: JB-1502/1503, JB-1601 to JB-1608, JB-1703, and regression rows
// D-14 (per-node selectors), D-16 (no work during drag), D-17 (incremental canvas mapping, culling), D-39.
import { describe, expect, it, vi } from 'vitest';
import { BoardStore, type ContentIn, type RemoteBatch } from '@/modules/jb/client/store';
import { BoardSync } from '@/modules/jb/client/sync';
import { addNode, DragSession, deleteNodes, nudge, patchCard, nearestInDirection, assignParent } from '@/modules/jb/client/actions';
import { CANVAS_PROPS, FlowNodeCache } from '@/modules/jb/client/flow';
import { runLimited, UPLOAD_CONCURRENCY } from '@/modules/jb/client/uploads';
import type { NodeRec, Op } from '@/modules/jb/ops';

const rec = (id: string, x = 0, y = 0, data: Record<string, unknown> = {}): NodeRec =>
  ({ id, kind: 'design-card', x, y, width: null, height: null, zIndex: null, sortKey: 'V', data: { title: id, ...data }, version: 1 });
const content = (nodes: NodeRec[], seq = 0): ContentIn => ({ seq, name: 'B', settings: {}, nodes, edges: [], fields: [] });
const remote = (seq: number, ops: Op[], results: RemoteBatch['results'] = [], clientId = 'other'): RemoteBatch =>
  ({ seq, batchId: `b${seq}`, clientId, userId: 'u2', ops, results });

describe('store', () => {
  it('D-14: an edit changes only the edited node reference; others keep theirs', () => {
    const s = new BoardStore('me'); s.load(content([rec('a'), rec('b')]));
    const b = s.view.nodes.get('b');
    patchCard(s, 'a', { title: 'A2' });
    expect(s.view.nodes.get('b')).toBe(b);
    expect(s.view.nodes.get('a')!.data.title).toBe('A2');
  });

  it('JB-1306: a read-only store refuses to produce ops', () => {
    const s = new BoardStore('me', true); s.load(content([rec('a')]));
    expect(patchCard(s, 'a', { title: 'x' })).toBe(false);
    expect(addNode(s, 'text', 0, 0)).toBeNull();
    expect(s.unsentCount).toBe(0);
  });

  it('JB-1503: remote ops land under pending local edits, which stay visible', () => {
    const s = new BoardStore('me'); s.load(content([rec('a')]));
    patchCard(s, 'a', { title: 'mine' }, { touch: false });
    expect(s.applyBatch(remote(1, [{ type: 'node', op: 'patch', id: 'a', data: { title: 'theirs', owner: 'Zed' } }], [{ type: 'node', id: 'a', version: 2 }]))).toBe('applied');
    expect(s.view.nodes.get('a')!.data).toMatchObject({ title: 'mine', owner: 'Zed' });
    expect(s.server.nodes.get('a')!.version).toBe(2);
    expect(s.applyBatch(remote(3, []))).toBe('gap'); // JB-1502: only seq + 1 applies
    expect(s.applyBatch(remote(1, []))).toBe('stale');
  });

  it('JB-1703: undo skips keys a collaborator changed since the step began', () => {
    const s = new BoardStore('me'); s.load(content([rec('a')]));
    patchCard(s, 'a', { title: 'T', owner: 'O' }, { touch: false });
    const sent = s.takeForSend(() => 'own-1')!; // saved and acknowledged
    s.applyBatch({ ...remote(1, sent.ops, [{ type: 'node', id: 'a', version: 2 }], 'me'), batchId: 'own-1' });
    s.applyBatch(remote(2, [{ type: 'node', op: 'patch', id: 'a', data: { owner: 'Remote' } }], [{ type: 'node', id: 'a', version: 3 }]));
    expect(s.undo()).toBe('done');
    expect(s.view.nodes.get('a')!.data).toMatchObject({ title: 'a', owner: 'Remote' });
    patchCard(s, 'a', { owner: 'Mine' }, { touch: false });
    s.applyBatch(remote(3, [{ type: 'node', op: 'patch', id: 'a', data: { owner: 'Remote2' } }], [{ type: 'node', id: 'a', version: 4 }]));
    expect(s.undo()).toBe('skipped'); // "Nothing to undo — others have changed these items"
  });

  it('JB-1702: one undo step per action; typing in one field within 1 s coalesces', () => {
    const s = new BoardStore('me'); s.load(content([rec('a')]));
    patchCard(s, 'a', { title: 'H' }, { touch: false });
    patchCard(s, 'a', { title: 'He' }, { touch: false });
    patchCard(s, 'a', { title: 'Hey' }, { touch: false });
    s.undo();
    expect(s.view.nodes.get('a')!.data.title).toBe('a');
    s.redo();
    expect(s.view.nodes.get('a')!.data.title).toBe('Hey');
  });

  it('JB-806 / JB-1704: delete with connectors keeps sub-items under the parent, and undo restores both', () => {
    const s = new BoardStore('me');
    s.load({ ...content([rec('root'), rec('mid', 0, 0, { parentId: 'root' }), rec('leaf', 0, 0, { parentId: 'mid' }), rec('x')]),
      edges: [{ id: 'e', source: 'mid', target: 'x', sortKey: 'V', data: {}, version: 1 }] });
    expect(deleteNodes(s, ['mid'], 'keep')).toBe(1);
    expect(s.view.nodes.get('leaf')!.data.parentId).toBe('root');
    expect(s.view.edges.size).toBe(0);
    s.undo();
    expect(s.view.nodes.get('mid')).toBeTruthy();
    expect(s.view.edges.get('e')).toBeTruthy();
    expect(s.view.nodes.get('leaf')!.data.parentId).toBe('mid');
    expect(deleteNodes(s, ['mid'], 'all')).toBe(2);
    expect(assignParent(s, ['root'], 'root')).toBe(0);
  });
});

describe('D-16 / PT-11: drag', () => {
  it('no ops, undo entries or outbox writes during a drag; exactly one batch and one undo step on stop', () => {
    const s = new BoardStore('me');
    s.load(content(Array.from({ length: 40 }, (_, i) => rec(`n${i}`, i * 300, 0))));
    const edits = vi.fn(); s.onLocalEdit = edits;
    const rev = s.revision;
    const drag = new DragSession(s, Array.from({ length: 30 }, (_, i) => `n${i}`));
    for (let f = 0; f < 180; f++) drag.positions(f, f); // 3 s at 60 fps
    expect([s.revision, s.unsentCount, s.canUndo, edits.mock.calls.length]).toEqual([rev, 0, false, 0]);
    expect(drag.near(0, 0).length).toBeLessThan(40); // grid lookup, not a full scan
    drag.end(50, 20);
    expect(edits).toHaveBeenCalledTimes(1);
    expect(s.pending).toHaveLength(30);
    s.undo();
    expect(s.view.nodes.get('n0')!.x).toBe(0);
  });

  it('a Design card carries its subtree; Alt+arrow nudges carry it too (JB-204, NFR-04)', () => {
    const s = new BoardStore('me'); s.load(content([rec('p'), rec('c', 0, 200, { parentId: 'p' })]));
    expect(new DragSession(s, ['p']).moving.sort()).toEqual(['c', 'p']);
    expect(nudge(s, ['p'], 8, 0)).toBe(2);
    expect(s.view.nodes.get('c')!.x).toBe(8);
  });
});

describe('D-17: canvas mapping', () => {
  it('renders only visible elements and reuses unchanged node objects', () => {
    expect(CANVAS_PROPS.onlyRenderVisibleElements).toBe(true);
    const s = new BoardStore('me'); s.load(content([rec('a'), rec('b')]));
    const cache = new FlowNodeCache();
    const first = cache.build(s.view.nodes, new Set(), false, (n) => n.id);
    const again = cache.build(s.view.nodes, new Set(), false, (n) => n.id);
    expect(again).toBe(first);
    patchCard(s, 'a', { title: 'z' });
    const next = cache.build(s.view.nodes, new Set(), false, (n) => n.id);
    expect(next.find((n) => n.id === 'b')).toBe(first.find((n) => n.id === 'b'));
    expect(next.find((n) => n.id === 'a')).not.toBe(first.find((n) => n.id === 'a'));
    expect(cache.build(s.view.nodes, new Set(), true, (n) => n.id).every((n) => n.draggable === false)).toBe(true); // D-28
  });

  it('NFR-04: arrow focus moves to the nearest node in that direction', () => {
    const nodes = [rec('o', 0, 0), rec('r', 400, 10), rec('far', 1200, 0), rec('d', 0, 300)];
    expect(nearestInDirection(nodes, nodes[0], 'right')!.id).toBe('r');
    expect(nearestInDirection(nodes, nodes[0], 'down')!.id).toBe('d');
    expect(nearestInDirection(nodes, nodes[0], 'left')).toBeNull();
  });
});

// ── sync engine with a fake server ───────────────────────────────────────────
function harness(responses: ((url: string, init?: RequestInit) => Response | Promise<Response>)[]) {
  const store = new BoardStore('me'); store.load(content([rec('a'), rec('b')]));
  const calls: { url: string; body: unknown }[] = [];
  const notices: string[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const r = responses[Math.min(i++, responses.length - 1)];
    return r(url, init);
  }) as unknown as typeof fetch;
  const timers: (() => void)[] = [];
  let ids = 0;
  const sync = new BoardSync(store, {
    boardId: 'B', fetch: fetchImpl, newId: () => `batch-${++ids}`, loadContent: async () => content([rec('a')], 9),
    onNotice: (m) => notices.push(m), setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {},
  });
  return { store, sync, calls, notices, timers };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('sync (JB-1601 to JB-1608)', () => {
  it('flushes 400 ms after the last edit, one batch, and advances seq from the response', async () => {
    const h = harness([() => json(200, { seq: 1, results: [{ type: 'node', id: 'a', version: 2 }] })]);
    patchCard(h.store, 'a', { title: '1' }); patchCard(h.store, 'b', { title: '2' });
    expect(h.timers).toHaveLength(2); // debounced: the last timer is the one that fires
    await h.sync.flush();
    expect(h.calls).toHaveLength(1);
    expect((h.calls[0].body as { ops: Op[] }).ops.map((o) => (o as { baseVersion: number }).baseVersion)).toEqual([1, 1]);
    expect([h.store.seq, h.store.unsentCount, h.store.server.nodes.get('a')!.version]).toEqual([1, 0, 2]);
  });

  it('retries a network failure with the SAME batchId (replay-safe)', async () => {
    const h = harness([() => { throw new TypeError('offline'); }, () => json(200, { seq: 1, results: [] })]);
    patchCard(h.store, 'a', { title: '1' });
    await h.sync.flush();
    expect(h.sync.status.kind).toMatch(/offline|retrying/);
    await h.sync.flush();
    expect((h.calls[0].body as { batchId: string }).batchId).toBe((h.calls[1].body as { batchId: string }).batchId);
  });

  it('409: pulls changes since seq, drops ops on remotely deleted objects, resends the rest', async () => {
    const h = harness([
      () => json(409, { code: 'conflict', details: { conflicts: [] } }),
      () => json(200, { seq: 1, more: false, batches: [remote(1, [{ type: 'node', op: 'delete', id: 'b' }])] }),
      () => json(200, { seq: 2, results: [{ type: 'node', id: 'a', version: 2 }] }),
    ]);
    patchCard(h.store, 'a', { title: 'x' }); patchCard(h.store, 'b', { title: 'y' });
    await h.sync.flush();
    expect(h.calls.map((c) => c.url)).toEqual(['/api/jb/boards/B/ops', '/api/jb/boards/B/changes?since=0', '/api/jb/boards/B/ops']);
    expect(h.notices[0]).toBe('1 of your changes were dropped because someone deleted those items.');
    expect([h.store.seq, h.store.unsentCount]).toEqual([2, 0]);
  });

  it('422 drops the batch and says why; 403 turns read-only and keeps the outbox; 426 locks', async () => {
    const h = harness([() => json(422, { message: 'Unknown card type' }), () => json(200, { seq: 0, batches: [], more: false })]);
    patchCard(h.store, 'a', { title: 'x' });
    await h.sync.flush();
    expect(h.notices[0]).toBe('Some changes could not be saved: Unknown card type');
    expect(h.store.view.nodes.get('a')!.data.title).toBe('a');

    const g = harness([() => json(403, {})]);
    patchCard(g.store, 'a', { title: 'x' });
    await g.sync.flush();
    expect([g.store.readOnly, g.store.unsentCount, g.sync.status.kind]).toEqual([true, 1, 'rights-lost']);
    expect(g.store.view.nodes.get('a')!.data.title).toBe('x');

    const k = harness([() => json(426, {})]);
    patchCard(k.store, 'a', { title: 'x' });
    await k.sync.flush();
    expect([k.sync.locked, k.store.unsentCount]).toEqual([true, 1]);
  });

  it('ARC-23: a realtime gap triggers a pull; own echo only advances seq; resync reloads content', async () => {
    const h = harness([
      () => json(200, { seq: 2, more: false, batches: [remote(1, [{ type: 'node', op: 'patch', id: 'a', data: { t: 1 } }], [{ type: 'node', id: 'a', version: 2 }]), remote(2, [])] }),
      () => json(200, { resync: true, seq: 9 }),
    ]);
    h.sync.onRemote(remote(2, []));
    await h.sync.pull();
    expect(h.store.seq).toBe(2);
    await h.sync.pull();
    expect(h.store.seq).toBe(9);
  });
});

describe('D-39: uploads', () => {
  it('run in parallel, at most 4 at a time', async () => {
    let active = 0; let peak = 0;
    const task = () => async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return 1; };
    const res = await runLimited(Array.from({ length: 10 }, task));
    expect(res.every((r) => r.status === 'fulfilled')).toBe(true);
    expect([peak, UPLOAD_CONCURRENCY]).toEqual([4, 4]);
  });
});
