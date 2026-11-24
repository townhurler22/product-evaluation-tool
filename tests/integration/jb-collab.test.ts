// Journey Boards: comments (§8.12, D-25), collaborators (JB-1302), images (§8.18), share links (§8.14,
// SEC-07 to SEC-10, D-30), export/import (§8.19), compaction (JB-1606, D-22) and delete (JB-104, ARC-29).
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { freshDb } from '../db';
import { call } from '../http';
import { card, createBoard, sendOps, signIn } from '../jb';
import { GET as commentsGet, POST as commentsPost } from '@/app/api/jb/boards/[id]/comments/route';
import { DELETE as threadDelete, PATCH as threadPatch, POST as threadReply } from '@/app/api/jb/boards/[id]/comments/[threadId]/route';
import { PATCH as messagePatch } from '@/app/api/jb/boards/[id]/comments/[threadId]/messages/[messageId]/route';
import { DELETE as collabDelete, GET as collabGet, POST as collabPost } from '@/app/api/jb/boards/[id]/collaborators/route';
import { GET as imagesGet, POST as imagesPost } from '@/app/api/jb/boards/[id]/images/route';
import { POST as exportRoute } from '@/app/api/jb/boards/export/route';
import { POST as importRoute } from '@/app/api/jb/boards/import/route';
import { DELETE as deleteRoute } from '@/app/api/jb/boards/[id]/route';
import { GET as changesRoute } from '@/app/api/jb/boards/[id]/changes/route';
import { POST as shareCreate } from '@/app/api/core/share-links/route';
import { GET as shareBoard } from '@/app/api/share/[token]/jb/board/route';
import { GET as shareContent } from '@/app/api/share/[token]/jb/boards/[boardId]/content/route';
import { GET as shareImages } from '@/app/api/share/[token]/jb/boards/[boardId]/images/route';
import { MemoryStorage, setStorage } from '@/modules/core/files/storage';
import { onBoardEvent } from '@/modules/jb/server/events';
import { compactBoards } from '@/modules/jb/register';
import '@/server/registrations';

let ctx: Awaited<ReturnType<typeof freshDb>>;
let store: MemoryStorage;
let admin: string, alice: string, bob: string, carol: string;

beforeEach(async () => {
  ctx = await freshDb();
  store = new MemoryStorage(); setStorage(store);
  await ctx.pg.query(`UPDATE core_setting SET value = '["team.test"]' WHERE key = 'auth.allowed_domains'`);
  admin = await signIn('owner@example.com');
  alice = await signIn('alice@team.test');
  bob = await signIn('bob@team.test');
  carol = await signIn('carol@team.test');
});

const invite = (cookie: string, id: string, email: string, role: string) => call(collabPost, { method: 'POST', cookie, params: { id }, body: { email, role } });
const png = (w = 8, h = 6) => sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } }).png().toBuffer();

async function upload(cookie: string, id: string, imageId: string, bytes: Buffer) {
  const form = new FormData();
  form.set('imageId', imageId);
  form.set('file', new Blob([new Uint8Array(bytes)]), 'shot.png');
  const req = new NextRequest(new URL(`/api/jb/boards/${id}/images`, 'http://localhost:3000'), {
    method: 'POST', body: form, headers: { cookie, origin: 'http://localhost:3000' },
  });
  const res = await imagesPost(req, { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}

describe('comments (§8.12)', () => {
  it('D-25: each write publishes the changed thread, with its messages', async () => {
    const id = (await createBoard(alice)).meta.id;
    await sendOps(alice, id, [card('a')]);
    const events: { event: string; payload: Record<string, unknown> }[] = [];
    const off = onBoardEvent((_c, event, payload) => events.push({ event, payload }));
    const t = await call(commentsPost, { method: 'POST', cookie: alice, params: { id }, body: { anchorType: 'NODE', anchorNodeId: 'a', x: 10, y: 5, body: 'Looks off' } });
    expect(t.status).toBe(201);
    const threadId = t.body.thread.id;
    await call(threadReply, { method: 'POST', cookie: alice, params: { id, threadId }, body: { body: 'Fixed' } });
    off();
    expect(events.map((e) => e.event)).toEqual(['comment.upserted', 'comment.upserted']);
    const thread = events[1].payload.thread as { id: string; messages: { body: string }[] };
    expect(thread.id).toBe(threadId);
    expect(thread.messages.map((m) => m.body)).toEqual(['Looks off', 'Fixed']);
  });

  it('commenters comment, viewers cannot; a pin on a deleted card is refused; delete by author, owner or manager', async () => {
    const id = (await createBoard(alice)).meta.id;
    await sendOps(alice, id, [card('a'), card('gone')]);
    await sendOps(alice, id, [{ type: 'node', op: 'delete', id: 'gone', baseVersion: 1 }]);
    await invite(alice, id, 'bob@team.test', 'VIEWER');
    await invite(alice, id, 'carol@team.test', 'COMMENTER');
    const body = { anchorType: 'BOARD', x: 0, y: 0, body: 'Hi' };
    expect((await call(commentsPost, { method: 'POST', cookie: bob, params: { id }, body })).status).toBe(403);
    const c = await call(commentsPost, { method: 'POST', cookie: carol, params: { id }, body });
    expect(c.status).toBe(201);
    expect((await call(commentsPost, { method: 'POST', cookie: carol, params: { id }, body: { ...body, anchorType: 'NODE', anchorNodeId: 'gone' } })).status).toBe(422);
    const threadId = c.body.thread.id;
    const messageId = c.body.thread.messages[0].id;
    expect((await call(messagePatch, { method: 'PATCH', cookie: alice, params: { id, threadId, messageId }, body: { body: 'x' } })).status).toBe(403);
    expect((await call(messagePatch, { method: 'PATCH', cookie: carol, params: { id, threadId, messageId }, body: { body: 'Hello' } })).body.thread.messages[0].editedAt).toBeTruthy();
    expect((await call(threadPatch, { method: 'PATCH', cookie: carol, params: { id, threadId }, body: { resolved: true } })).body.thread.resolvedAt).toBeTruthy();
    expect((await call(commentsGet, { cookie: bob, params: { id } })).body.threads).toHaveLength(1); // viewers read
    expect((await call(threadDelete, { method: 'DELETE', cookie: alice, params: { id, threadId } })).status).toBe(204); // owner
    const long = await call(commentsPost, { method: 'POST', cookie: carol, params: { id }, body: { ...body, body: 'x'.repeat(2001) } });
    expect(long.status).toBe(400); // over-length is rejected, never cut (SEC-13)
  });
});

describe('collaborators (JB-1302)', () => {
  it('invites existing active users only, never the owner; re-inviting changes the role; anyone may leave', async () => {
    const id = (await createBoard(alice)).meta.id;
    expect((await invite(alice, id, 'nobody@team.test', 'EDITOR')).status).toBe(422);
    expect((await invite(alice, id, 'alice@team.test', 'EDITOR')).status).toBe(422);
    expect((await invite(bob, id, 'carol@team.test', 'EDITOR')).status).toBe(404); // cannot see the board
    await invite(alice, id, 'BOB@team.test', 'VIEWER');
    await invite(alice, id, 'bob@team.test', 'EDITOR');
    const list = await call(collabGet, { cookie: bob, params: { id } });
    expect(list.body.collaborators.map((c: { email: string; role: string }) => [c.email, c.role])).toEqual([['bob@team.test', 'EDITOR']]);
    const bobId = list.body.collaborators[0].userId;
    expect((await call(collabDelete, { method: 'DELETE', cookie: bob, params: { id }, path: `/x?userId=${bobId}` })).status).toBe(204);
    const audit = await ctx.pg.query<{ action: string }>(`SELECT action FROM core_audit_log WHERE action LIKE 'jb.collaborator%' ORDER BY created_at`);
    expect(audit.rows.map((r: { action: string }) => r.action)).toEqual(['jb.collaborator.set', 'jb.collaborator.set', 'jb.collaborator.remove']);
  });
});

describe('images (§8.18)', () => {
  it('editors upload sniffed images; SVG is 415; viewers get signed URLs for ids in view', async () => {
    const id = (await createBoard(alice)).meta.id;
    expect((await upload(alice, id, 'img1', await png())).status).toBe(201);
    expect((await upload(alice, id, 'svg1', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).status).toBe(415);
    await invite(alice, id, 'bob@team.test', 'VIEWER');
    expect((await upload(bob, id, 'img2', await png())).status).toBe(403);
    const r = await call(imagesGet, { cookie: bob, params: { id }, path: `/x?ids=img1,missing` });
    expect(Object.keys(r.body.urls)).toEqual(['img1']);
    expect(r.body.urls.img1).toMatch(/^https:\/\/storage\.test\/jb\/board\//);
  });

  it('JB-1801: images over 2,560 px on the long edge are downscaled', async () => {
    const id = (await createBoard(alice)).meta.id;
    expect((await upload(alice, id, 'big', await png(3000, 100))).status).toBe(201);
    const [obj] = [...store.objects.values()];
    const meta = await sharp(obj.bytes).metadata();
    expect([meta.format, meta.width]).toEqual(['jpeg', 2560]);
  });

  it('ARC-29: deleting a board deletes its journeys and their files after commit', async () => {
    const id = (await createBoard(alice)).meta.id;
    await sendOps(alice, id, [card('pc', 0, 0, {}, 'product-card')]);
    const journey = (await createBoard(alice, { name: 'J', journeyOf: { boardId: id, nodeId: 'pc' } })).meta.id;
    await upload(alice, id, 'a', await png());
    await upload(alice, journey, 'b', await png());
    expect(store.objects.size).toBe(2);
    expect((await call(deleteRoute, { method: 'DELETE', cookie: alice, params: { id } })).status).toBe(204);
    expect(store.objects.size).toBe(0);
    expect((await ctx.pg.query(`SELECT count(*)::int AS n FROM jb_board`)).rows[0]).toEqual({ n: 0 });
    expect((await ctx.pg.query(`SELECT count(*)::int AS n FROM core_file`)).rows[0]).toEqual({ n: 0 });
  });
});

describe('board share links (§8.14, D-30)', () => {
  async function link(cookie: string, boardId: string) {
    const r = await call(shareCreate, { method: 'POST', cookie, body: { module: 'jb', targetKind: 'board', targetId: boardId, capabilities: ['VIEW'] } });
    return { status: r.status, token: r.status === 201 ? new URL(r.body.url).pathname.split('/').pop()! : '' };
  }
  const shareCall = (h: typeof shareBoard, token: string, params: Record<string, string> = {}, query = '') =>
    call(h as Parameters<typeof call>[0], { path: `/api/share/${token}/jb/x${query}`, params: { token, ...params } });

  it('serves the board and its journeys read-only, with images of both, and nothing internal', async () => {
    const id = (await createBoard(alice, { name: 'Shared', template: 'sample' })).meta.id;
    const journey = (await createBoard(alice, { name: 'Journey', journeyOf: { boardId: id, nodeId: 'pc-onboarding' } })).meta.id;
    await upload(alice, journey, 'jimg', await png());
    expect((await link(bob, id)).status).toBe(404); // only owners and managers create links
    const { token } = await link(alice, id);
    const r = await shareCall(shareBoard, token);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['board', 'content', 'journeys']);
    expect(r.body.board).toEqual({ id, name: 'Shared', journeyOfNodeId: null });
    expect(r.body.journeys).toEqual([{ id: journey, name: 'Journey', journeyOfNodeId: 'pc-onboarding' }]);
    expect(JSON.stringify(r.body)).not.toMatch(/ownerId|owner_id|collab|viewport|comment/);
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await shareCall(shareContent, token, { boardId: journey })).status).toBe(200);
    expect(Object.keys((await shareCall(shareImages, token, { boardId: journey }, '?ids=jimg')).body.urls)).toEqual(['jimg']);
    // SEC-10: another board through this link is the same 404 as a missing link.
    const other = (await createBoard(alice, { name: 'Other' })).meta.id;
    const miss = await shareCall(shareContent, token, { boardId: other });
    const bogus = await shareCall(shareContent, 'A'.repeat(43), { boardId: other });
    expect([miss.status, JSON.stringify(miss.body)]).toEqual([404, JSON.stringify(bogus.body)]);
  });

  it('SEC-08: a link stops when its creator can no longer view the board with workspace edit off', async () => {
    const id = (await createBoard(alice, { name: 'Sample', template: 'sample' })).meta.id; // workspace edit on
    await invite(alice, id, 'bob@team.test', 'VIEWER');
    const bobLinkTry = await link(bob, id);
    expect(bobLinkTry.status).toBe(404);
    const { token } = await link(admin, id);
    expect((await shareCall(shareBoard, token)).status).toBe(200);
    await ctx.pg.query(`UPDATE core_user SET status = 'DISABLED' WHERE email = 'owner@example.com'`);
    expect((await shareCall(shareBoard, token)).status).toBe(404);
    void carol;
  });
});

describe('export and import (§8.19)', () => {
  it('round-trips into NEW boards with journeys; unknown keys survive; comments are not exported', async () => {
    const id = (await createBoard(alice, { name: 'Src', template: 'sample' })).meta.id;
    await sendOps(alice, id, [{ type: 'node', op: 'patch', id: 'dc-signup', baseVersion: 1, data: { futureKey: { keep: [1, 2] } } }]);
    await createBoard(alice, { name: 'J', journeyOf: { boardId: id, nodeId: 'pc-onboarding' } });
    await call(commentsPost, { method: 'POST', cookie: alice, params: { id }, body: { anchorType: 'BOARD', x: 0, y: 0, body: 'Secret note' } });
    const doc = (await call(exportRoute, { method: 'POST', cookie: alice, body: { boardIds: [id] } })).body;
    expect(doc.format).toBe('pet.journey-boards');
    expect(JSON.stringify(doc)).not.toContain('Secret note');
    expect(doc.boards[0].journeys).toHaveLength(1);
    const imported = await call(importRoute, { method: 'POST', cookie: bob, body: doc });
    expect(imported.status).toBe(201);
    const newId = imported.body.boards[0].id;
    expect(newId).not.toBe(id);
    const row = await ctx.pg.query<{ data: Record<string, unknown> }>(`SELECT data FROM jb_node WHERE board_id = $1 AND id = 'dc-signup'`, [newId]);
    expect(row.rows[0].data.futureKey).toEqual({ keep: [1, 2] });
    expect((await ctx.pg.query(`SELECT count(*)::int AS n FROM jb_board WHERE journey_of_board_id = $1`, [newId])).rows[0]).toEqual({ n: 1 });
    const priv = (await createBoard(alice, { name: 'Private' })).meta.id;
    expect((await call(exportRoute, { method: 'POST', cookie: carol, body: { boardIds: [priv] } })).status).toBe(404);
  });

  it('refuses an invalid file with the first error path', async () => {
    const r = await call(importRoute, { method: 'POST', cookie: alice, body: {
      format: 'pet.journey-boards', schemaVersion: 1,
      boards: [{ name: 'X', fields: [], nodes: [{ id: 'a', kind: 'design-card', x: 0, y: 0, sortKey: 'V', data: {} }], edges: [{ id: 'e', source: 'a', target: 'nope', sortKey: 'V' }] }],
    } });
    expect([r.status, r.body.details.field]).toEqual([400, 'boards.0.edges.0']);
  });
});

describe('change-log retention (JB-1606, OD-25, D-22)', () => {
  it('compaction snapshots, removes old change rows and tombstones, and answers resync below compacted_seq', async () => {
    const id = (await createBoard(alice)).meta.id;
    await sendOps(alice, id, [card('a'), card('b')]);
    await sendOps(alice, id, [{ type: 'node', op: 'delete', id: 'b', baseVersion: 1 }]);
    await ctx.pg.query(`UPDATE jb_change SET created_at = now() - interval '31 days'`);
    await ctx.pg.query(`UPDATE jb_node SET deleted_at = now() - interval '31 days' WHERE deleted_at IS NOT NULL`);
    await sendOps(alice, id, [card('c')]);
    expect(await compactBoards()).toBe(1);
    expect((await ctx.pg.query(`SELECT seq::int FROM jb_change WHERE board_id = $1`, [id])).rows).toEqual([{ seq: 3 }]);
    expect((await ctx.pg.query<{ id: string }>(`SELECT id FROM jb_node WHERE board_id = $1 ORDER BY id`, [id])).rows.map((r: { id: string }) => r.id)).toEqual(['a', 'c']);
    expect((await ctx.pg.query(`SELECT count(*)::int AS n FROM jb_snapshot`)).rows[0]).toEqual({ n: 1 });
    expect((await call(changesRoute, { cookie: alice, params: { id }, path: `/x?since=1` })).body.resync).toBe(true);
    expect((await call(changesRoute, { cookie: alice, params: { id }, path: `/x?since=2` })).body.batches).toHaveLength(1);
  });
});
