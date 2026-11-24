// Journey Boards: boards, access matrix (§8.13), op batches (JB-1601/1602, PERF-25, INV-19/20/22),
// changes and gap recovery (ARC-23), and regression rows D-20 to D-24, D-28, PT-09, PT-13.
import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from '../db';
import { call } from '../http';
import { batchId, card, createBoard, edge, sendOps, signIn } from '../jb';
import { GET as listRoute } from '@/app/api/jb/boards/route';
import { GET as contentRoute } from '@/app/api/jb/boards/[id]/content/route';
import { GET as changesRoute } from '@/app/api/jb/boards/[id]/changes/route';
import { POST as opsRoute } from '@/app/api/jb/boards/[id]/ops/route';
import { PATCH as accessRoute } from '@/app/api/jb/boards/[id]/access/route';
import { PATCH as viewportRoute } from '@/app/api/jb/boards/[id]/viewport/route';
import { DELETE as deleteRoute } from '@/app/api/jb/boards/[id]/route';
import { POST as collabPost } from '@/app/api/jb/boards/[id]/collaborators/route';
import { POST as tokenRoute } from '@/app/api/core/realtime/token/route';
import { onBoardEvent } from '@/modules/jb/server/events';
import { resolveCards } from '@/modules/jb/service';
import { clearPrincipalCache } from '@/modules/core/auth/principal';
import type { Op } from '@/modules/jb/ops';

let ctx: Awaited<ReturnType<typeof freshDb>>;
let admin: string, alice: string, bob: string, carol: string;

beforeEach(async () => {
  ctx = await freshDb();
  await ctx.pg.query(`UPDATE core_setting SET value = '["team.test"]' WHERE key = 'auth.allowed_domains'`);
  admin = await signIn('owner@example.com');
  alice = await signIn('alice@team.test');
  bob = await signIn('bob@team.test');
  carol = await signIn('carol@team.test');
});

const content = (cookie: string, id: string) => call(contentRoute, { cookie, params: { id }, path: `/api/jb/boards/${id}/content` });
const changes = (cookie: string, id: string, since: number) => call(changesRoute, { cookie, params: { id }, path: `/api/jb/boards/${id}/changes?since=${since}` });
const invite = (cookie: string, id: string, email: string, role: string) =>
  call(collabPost, { method: 'POST', cookie, params: { id }, body: { email, role } });

describe('boards and metadata (§8.1, PERF-24)', () => {
  it('new boards start with workspace edit off; the sample template starts on (OD-23)', async () => {
    const blank = await createBoard(alice, { name: 'Blank' });
    expect(blank.meta.workspaceCanEdit).toBe(false);
    expect(blank.content.fields.map((f) => f.id)).toEqual(['status']);
    const sample = await createBoard(alice, { name: 'Sample', template: 'sample' });
    expect(sample.meta.workspaceCanEdit).toBe(true);
    expect(sample.content.nodes.length).toBeGreaterThan(5);
  });

  it('D-20 / PT-09: GET boards is metadata only, one request, statement count independent of board count', async () => {
    await createBoard(alice, { name: 'One', template: 'sample' });
    clearPrincipalCache();
    const one = await call(listRoute, { cookie: alice });
    for (let i = 0; i < 12; i++) await createBoard(alice, { name: `B${i}` });
    clearPrincipalCache();
    const many = await call(listRoute, { cookie: alice });
    expect(many.body.boards).toHaveLength(13);
    expect(many.statements).toBe(one.statements);
    expect(many.statements).toBeLessThanOrEqual(2);
    expect(Object.keys(many.body.boards[0]).sort()).toEqual(
      ['createdAt', 'id', 'journeyCount', 'journeyOf', 'name', 'nodeCount', 'ownerId', 'ownerName', 'rights', 'updatedAt', 'workspaceCanEdit']);
    expect(JSON.stringify(many.body)).not.toContain('"nodes"');
  });

  it('lists only boards the viewer may view; admin sees all; oldest first', async () => {
    const a = await createBoard(alice, { name: 'Private' });
    const s = await createBoard(alice, { name: 'Shared', template: 'sample' });
    const names = async (c: string) => (await call(listRoute, { cookie: c })).body.boards.map((b: { name: string }) => b.name);
    expect(await names(bob)).toEqual(['Shared']);
    expect(await names(admin)).toEqual(['Private', 'Shared']);
    await invite(alice, a.meta.id, 'bob@team.test', 'VIEWER');
    expect(await names(bob)).toEqual(['Private', 'Shared']);
    void s;
  });

  it('content is 4 statements (access, nodes, edges, fields) and never carries tombstones (D-22, D-23)', async () => {
    const b = await createBoard(alice);
    const id = b.meta.id;
    expect((await sendOps(alice, id, [card('a'), card('b')])).status).toBe(200);
    await sendOps(alice, id, [{ type: 'node', op: 'delete', id: 'b', baseVersion: 1 }]);
    await content(alice, id); // warm the principal cache
    const r = await content(alice, id);
    expect(r.statements).toBe(4);
    expect(r.body.content.nodes.map((n: { id: string }) => n.id)).toEqual(['a']);
    expect(r.body.content.seq).toBe(2);
  });
});

describe('effective rights (§8.13, JB-1305, D-28)', () => {
  it('hidden board → 404 everywhere; visible but not allowed → 403', async () => {
    const b = await createBoard(alice);
    const id = b.meta.id;
    expect((await content(bob, id)).status).toBe(404);
    expect((await sendOps(bob, id, [card('x')])).status).toBe(404);
    await invite(alice, id, 'bob@team.test', 'VIEWER');
    await invite(alice, id, 'carol@team.test', 'COMMENTER');
    const viewer = await content(bob, id);
    expect(viewer.status).toBe(200);
    expect(viewer.body.meta.rights).toEqual({ role: 'viewer', canEdit: false, canComment: false, canManage: false });
    expect((await content(carol, id)).body.meta.rights).toEqual({ role: 'commenter', canEdit: false, canComment: true, canManage: false });
    expect((await sendOps(bob, id, [card('x')])).status).toBe(403);
    expect((await sendOps(carol, id, [card('x')])).status).toBe(403);
    // Workspace edit on lifts viewers and commenters to edit; never to manage (JB-1301).
    expect((await call(accessRoute, { method: 'PATCH', cookie: alice, params: { id }, body: { workspaceCanEdit: true } })).status).toBe(200);
    expect((await sendOps(bob, id, [card('x')])).status).toBe(200);
    expect((await call(accessRoute, { method: 'PATCH', cookie: bob, params: { id }, body: { workspaceCanEdit: false } })).status).toBe(403);
    expect((await call(deleteRoute, { method: 'DELETE', cookie: bob, params: { id } })).status).toBe(403);
  });

  it('a journey is judged by its parent and its workspace edit cannot be set (JB-1303)', async () => {
    const parent = await createBoard(alice, { name: 'Parent' });
    await sendOps(alice, parent.meta.id, [card('pc', 0, 0, {}, 'product-card')]);
    const journey = await createBoard(alice, { name: 'Journey', journeyOf: { boardId: parent.meta.id, nodeId: 'pc' } });
    expect((await content(bob, journey.meta.id)).status).toBe(404);
    await invite(alice, parent.meta.id, 'bob@team.test', 'EDITOR');
    expect((await content(bob, journey.meta.id)).body.meta.rights.canEdit).toBe(true);
    expect((await call(accessRoute, { method: 'PATCH', cookie: alice, params: { id: journey.meta.id }, body: { workspaceCanEdit: true } })).status).toBe(422);
    // INV-21: one journey per card; journeys never nest.
    expect((await call((await import('@/app/api/jb/boards/route')).POST, { method: 'POST', cookie: alice, body: { name: 'Again', journeyOf: { boardId: parent.meta.id, nodeId: 'pc' } } })).status).toBe(409);
  });

  it('realtime channel authorisation uses the board rights', async () => {
    const b = await createBoard(alice);
    const r = await call(tokenRoute, { method: 'POST', cookie: bob, body: { channels: [`jb.board.${b.meta.id}`, 'jb.workspace'] } });
    expect(r.status).toBe(200); // no secret in tests → { available: false }, but the rule still ran
    const { authoriseChannels } = await import('@/modules/core/realtime');
    const { loadPrincipal } = await import('@/modules/core/auth/principal');
    void loadPrincipal;
    const principal = { userId: (await ctx.pg.query<{ id: string }>(`SELECT id FROM core_user WHERE email='bob@team.test'`)).rows[0].id, sessionId: 's', role: 'MEMBER' as const, isFeedbackAdmin: false, isWorkspaceAdmin: false, canDeletePosts: false };
    expect(await authoriseChannels(principal, [`jb.board.${b.meta.id}`])).toEqual([]);
    await invite(alice, b.meta.id, 'bob@team.test', 'VIEWER');
    expect(await authoriseChannels(principal, [`jb.board.${b.meta.id}`])).toEqual([`jb.board.${b.meta.id}`]);
  });
});

describe('op batches (JB-1601, JB-1602, PERF-25)', () => {
  let id: string;
  beforeEach(async () => { id = (await createBoard(alice)).meta.id; });

  it('applies all or nothing and replays a repeated batchId (INV-22)', async () => {
    const body = { batchId: batchId(), clientId: 'client-1', protocol: 1, ops: [card('a'), card('b')] };
    const first = await call(opsRoute, { method: 'POST', cookie: alice, params: { id }, body });
    expect(first.body).toEqual({ seq: 1, results: [{ type: 'node', id: 'a', version: 1 }, { type: 'node', id: 'b', version: 1 }] });
    const again = await call(opsRoute, { method: 'POST', cookie: alice, params: { id }, body });
    expect(again.body).toEqual({ ...first.body, replayed: true });
    // A failing op rolls back the whole batch; seq does not move.
    const bad = await sendOps(alice, id, [card('c'), { type: 'node', op: 'patch', id: 'a', baseVersion: 7, set: { x: 1 } }]);
    expect(bad.status).toBe(409);
    expect(bad.body.details.conflicts).toEqual([{ type: 'node', id: 'a', reason: 'stale' }]);
    const r = await content(alice, id);
    expect(r.body.content.seq).toBe(1);
    expect(r.body.content.nodes.map((n: { id: string }) => n.id)).toEqual(['a', 'b']);
  });

  it('seq rises by exactly one per applied batch, also for racing batches (INV-22)', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => sendOps(alice, id, [card(`n${i}`)])));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(results.map((r) => r.body.seq).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('refuses bad ops with 422 {opIndex}', async () => {
    const unknown = await sendOps(alice, id, [card('a'), card('z', 0, 0, {}, 'mystery-kind')]);
    expect([unknown.status, unknown.body.message, unknown.body.details.opIndex]).toEqual([422, 'Unknown card type', 1]);
    await sendOps(alice, id, [card('a')]);
    const noBase = await sendOps(alice, id, [{ type: 'node', op: 'patch', id: 'a', set: { x: 5 } }]);
    expect([noBase.status, noBase.body.message]).toEqual([422, 'baseVersion is required.']);
    const order = await sendOps(alice, id, [{ type: 'node', op: 'delete', id: 'a', baseVersion: 1 }, { type: 'node', op: 'restore', id: 'a', baseVersion: 2 }]);
    expect(order.status).toBe(422);
    expect((await sendOps(alice, id, [card('b'), { type: 'node', op: 'patch', id: 'b', set: { kind: 'x' } }])).status).toBe(422);
  });

  it('426 for an outdated client (JB-2003)', async () => {
    expect((await sendOps(alice, id, [card('a')], { protocol: 0 })).status).toBe(426);
  });

  it('INV-19: connectors join live nodes; deleting a card needs its connectors deleted in the same batch', async () => {
    expect((await sendOps(alice, id, [card('a'), edge('e1', 'a', 'missing')])).status).toBe(422);
    expect((await sendOps(alice, id, [card('a'), card('b'), edge('e1', 'a', 'b')])).status).toBe(200);
    const orphan = await sendOps(alice, id, [{ type: 'node', op: 'delete', id: 'b', baseVersion: 1 }]);
    expect([orphan.status, orphan.body.message]).toEqual([422, 'Delete a card\'s connectors with it.']);
    const both = await sendOps(alice, id, [{ type: 'edge', op: 'delete', id: 'e1', baseVersion: 1 }, { type: 'node', op: 'delete', id: 'b', baseVersion: 1 }]);
    expect(both.status).toBe(200);
    // Undo restores both (JB-1704); a restore carries the restored row for every client.
    const undo = await sendOps(alice, id, [{ type: 'node', op: 'restore', id: 'b', baseVersion: 2 }, { type: 'edge', op: 'restore', id: 'e1', baseVersion: 2 }]);
    expect(undo.status).toBe(200);
    const ch = await changes(alice, id, both.body.seq);
    expect(ch.body.batches[0].ops[0].value).toMatchObject({ kind: 'design-card', data: { title: 'b' } });
    const counts = await ctx.pg.query(`SELECT live_node_count, live_edge_count FROM jb_board WHERE id = $1`, [id]);
    expect(counts.rows[0]).toEqual({ live_node_count: 2, live_edge_count: 1 });
  });

  it('INV-20: a card cannot be its own ancestor; only Design cards have parents (JB-801, JB-803)', async () => {
    await sendOps(alice, id, [card('p'), card('c', 0, 0, { parentId: 'p' }), card('pc', 0, 0, {}, 'product-card')]);
    const cyc = await sendOps(alice, id, [{ type: 'node', op: 'patch', id: 'p', baseVersion: 1, data: { parentId: 'c' } }]);
    expect([cyc.status, cyc.body.message]).toEqual([422, 'A card cannot be its own ancestor']);
    expect((await sendOps(alice, id, [{ type: 'node', op: 'patch', id: 'c', baseVersion: 1, data: { parentId: 'pc' } }])).status).toBe(422);
    expect((await sendOps(alice, id, [card('q', 0, 0, { parentId: 'p' }, 'product-card')])).status).toBe(422);
  });

  it('patches merge data one level deep; fieldValues merge per field; same key: later save wins (JB-1605)', async () => {
    await sendOps(alice, id, [card('a', 0, 0, { owner: 'Ann', fieldValues: { status: 'current' } })]);
    await sendOps(alice, id, [{ type: 'node', op: 'patch', id: 'a', baseVersion: 1, data: { 'fieldValues.size': 'L', area: 'Pay' } }]);
    await sendOps(alice, id, [{ type: 'node', op: 'patch', id: 'a', baseVersion: 2, unset: ['owner'], data: { 'fieldValues.status': 'legacy' } }]);
    const n = (await content(alice, id)).body.content.nodes[0];
    expect(n.data).toMatchObject({ title: 'a', area: 'Pay', fieldValues: { status: 'legacy', size: 'L' } });
    expect(n.data.owner).toBeUndefined();
    expect(n.version).toBe(3);
  });

  it('the Design status field can be renamed but never deleted (JB-901)', async () => {
    expect((await sendOps(alice, id, [{ type: 'field', op: 'patch', id: 'status', baseVersion: 1, set: { label: 'State' } }])).status).toBe(200);
    const del = await sendOps(alice, id, [{ type: 'field', op: 'delete', id: 'status', baseVersion: 2 }]);
    expect([del.status, del.body.message]).toEqual([422, 'The Design status field cannot be deleted.']);
  });

  it('board.patch renames and merges settings per key; sanitises text (SEC-13)', async () => {
    await sendOps(alice, id, [{ type: 'board', op: 'patch', name: ' New‮name ', settings: { health: { staleDays: 60 } } }]);
    await sendOps(alice, id, [{ type: 'board', op: 'patch', settings: { showChangeSummary: true } }]);
    const r = await content(alice, id);
    expect(r.body.content.name).toBe('Newname');
    expect(r.body.content.settings).toEqual({ health: { staleDays: 60 }, showChangeSummary: true });
  });

  it('viewport is saved by editors only and does not move updated_at (JB-106)', async () => {
    const before = (await ctx.pg.query<{ updated_at: Date }>(`SELECT updated_at FROM jb_board WHERE id = $1`, [id])).rows[0].updated_at;
    expect((await call(viewportRoute, { method: 'PATCH', cookie: alice, params: { id }, body: { x: 1, y: 2, zoom: 1.5 } })).status).toBe(204);
    const after = (await ctx.pg.query<{ updated_at: Date; viewport: unknown }>(`SELECT updated_at, viewport FROM jb_board WHERE id = $1`, [id])).rows[0];
    expect(after.updated_at).toEqual(before);
    expect(after.viewport).toEqual({ x: 1, y: 2, zoom: 1.5 });
  });
});

describe('statement budgets (PT-13, D-21)', () => {
  async function boardWith(nodes: number) {
    const id = (await createBoard(alice)).meta.id;
    for (let i = 0; i < nodes; i += 500) {
      const ops: Op[] = Array.from({ length: Math.min(500, nodes - i) }, (_, k) => card(`n${i + k}`, (i + k) * 10, 0));
      expect((await sendOps(alice, id, ops)).status).toBe(200);
    }
    return id;
  }
  const fiftyPatches = (): Op[] => Array.from({ length: 50 }, (_, k) => ({ type: 'node', op: 'patch', id: `n${k}`, baseVersion: 1, set: { x: k, y: 5 }, data: { title: `moved ${k}` } }));

  it('a 50-op batch costs the same statements on a 200-node and a 2,000-node board, at most 8', async () => {
    const small = await boardWith(200);
    const large = await boardWith(2000);
    await content(alice, small); // principal cache warm, as in steady use
    const a = await sendOps(alice, small, fiftyPatches());
    const b = await sendOps(alice, large, fiftyPatches());
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.statements).toBe(b.statements);
    expect(a.statements).toBeLessThanOrEqual(8);
  }, 120_000);

  it('content statements do not grow with board size', async () => {
    const small = await boardWith(10);
    const large = await boardWith(600);
    await content(alice, small);
    expect((await content(alice, small)).statements).toBe((await content(alice, large)).statements);
  }, 60_000);
});

describe('live sync (JB-1501, JB-1502, D-24)', () => {
  it('D-24: every applied batch is published with its seq and ops; large payloads become ops.available', async () => {
    const id = (await createBoard(alice)).meta.id;
    const events: { channel: string; event: string; payload: Record<string, unknown> }[] = [];
    const off = onBoardEvent((channel, event, payload) => events.push({ channel, event, payload }));
    await sendOps(alice, id, [card('a')], { clientId: 'client-A' });
    const big = Array.from({ length: 60 }, (_, k) => card(`big${k}`, 0, 0, { description: 'x'.repeat(200) }));
    await sendOps(alice, id, big);
    off();
    expect(events[0]).toMatchObject({ channel: `jb.board.${id}`, event: 'ops.applied', payload: { seq: 1, clientId: 'client-A', ops: [{ op: 'create', id: 'a' }] } });
    expect(events[1]).toEqual({ channel: `jb.board.${id}`, event: 'ops.available', payload: { seq: 2 } });
  });

  it('changes?since returns missed batches in seq order (gap recovery) and {resync} below compacted_seq', async () => {
    const id = (await createBoard(alice)).meta.id;
    await sendOps(alice, id, [card('a')]);
    await sendOps(alice, id, [{ type: 'node', op: 'patch', id: 'a', baseVersion: 1, set: { x: 9 } }]);
    await sendOps(alice, id, [card('b')]);
    const r = await changes(alice, id, 1);
    expect(r.body.seq).toBe(3);
    expect(r.body.batches.map((b: { seq: number }) => b.seq)).toEqual([2, 3]);
    expect(r.body.batches[0].results).toEqual([{ type: 'node', id: 'a', version: 2 }]);
    expect((await changes(alice, id, 3)).body).toEqual({ seq: 3, batches: [], more: false });
    await ctx.pg.query(`UPDATE jb_board SET compacted_seq = 2 WHERE id = $1`, [id]);
    expect((await changes(alice, id, 1)).body).toEqual({ resync: true, seq: 3 });
    expect((await changes(alice, id, -1)).status).toBe(400);
  });
});

describe('service interface (§11.4)', () => {
  it('resolveCards returns refs, "gone" for deleted cards and boards, and omits boards the viewer cannot see', async () => {
    const id = (await createBoard(alice)).meta.id;
    await sendOps(alice, id, [card('a'), card('b')]);
    await sendOps(alice, id, [{ type: 'node', op: 'delete', id: 'b', baseVersion: 1 }]);
    const aliceP = { userId: (await ctx.pg.query<{ id: string }>(`SELECT id FROM core_user WHERE email='alice@team.test'`)).rows[0].id, sessionId: 's', role: 'MEMBER' as const, isFeedbackAdmin: false, isWorkspaceAdmin: false, canDeletePosts: false };
    const bobP = { ...aliceP, userId: (await ctx.pg.query<{ id: string }>(`SELECT id FROM core_user WHERE email='bob@team.test'`)).rows[0].id };
    const ids = [`${id}:a`, `${id}:b`, '0190c3a0-0000-7000-8000-00000000dead:x'];
    const r = await resolveCards(aliceP, ids);
    expect(r[`${id}:a`]).toMatchObject({ title: 'a', kind: 'design-card' });
    expect(r[`${id}:b`]).toBe('gone');
    expect(r['0190c3a0-0000-7000-8000-00000000dead:x']).toBe('gone');
    expect(Object.keys(await resolveCards(bobP, ids))).toEqual(['0190c3a0-0000-7000-8000-00000000dead:x']);
  });
});
