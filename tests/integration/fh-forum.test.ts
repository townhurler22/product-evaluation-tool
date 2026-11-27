// P3 forum administration and publishing: FH-1101 to FH-1108, FH-1254, FH-411 to FH-413, D-34, D-35.
import { beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { freshDb } from '../db';
import { call, signInAll } from '../fh';
import { makeForum, makeLink, postForm, share } from '../forum';
import { MemoryStorage, setStorage } from '@/modules/core/files/storage';
import { clearPrincipalCache } from '@/modules/core/auth/principal';
import { slugify } from '@/modules/fh/forum-domain';
import { GET as listForumsR, POST as createForumR } from '@/app/api/fh/forums/route';
import { PATCH as patchForumR } from '@/app/api/fh/forums/[id]/route';
import { GET as forumPostsR } from '@/app/api/fh/forums/[id]/posts/route';
import { DELETE as deletePostR, PATCH as editPostR } from '@/app/api/fh/forums/[id]/posts/[postId]/route';
import { DELETE as teamUnvoteR, POST as teamVoteR } from '@/app/api/fh/forums/[id]/posts/[postId]/team-vote/route';
import { GET as statusGetR, PUT as statusPutR } from '@/app/api/fh/status-config/route';
import { POST as previewR } from '@/app/api/fh/ideas/publish/preview/route';
import { POST as publishR } from '@/app/api/fh/ideas/publish/route';
import { GET as ideaImagesR } from '@/app/api/fh/ideas/[id]/images/route';
import { POST as createIdeaR } from '@/app/api/fh/ideas/route';
import { GET as ideasR } from '@/app/api/fh/ideas/route';
import * as submitR from '@/app/api/share/[token]/fh/posts/route';
import * as forumPublicPostsR from '@/app/api/share/[token]/fh/forum/posts/route';

let ctx: Awaited<ReturnType<typeof freshDb>>;
let admin: string, pm: string, member: string;
let store: MemoryStorage;

beforeEach(async () => {
  ctx = await freshDb();
  ({ admin, pm, member } = await signInAll(ctx.pg));
  store = new MemoryStorage();
  setStorage(store);
});

const png = () => sharp({ create: { width: 4, height: 4, channels: 3, background: '#00f' } }).png().toBuffer();
const createIdea = async (title: string, extra: Record<string, unknown> = {}) =>
  (await call(createIdeaR, { method: 'POST', cookie: admin, body: { title, ...extra } })).body.row.id as string;

describe('forums (FH-1101 to FH-1103)', () => {
  it('slugs: NFKD, no diacritics, lower case, dashes, at most 60', () => {
    expect(slugify('Café Ideas & Requests!')).toBe('cafe-ideas-requests');
    expect(slugify('  --Ünïcödé--  ')).toBe('unicode');
    expect(slugify('!!!')).toBe('');
    expect(slugify('a'.repeat(70)).length).toBe(60);
  });

  it('create, clash 409, empty slug 400, list archived last with links', async () => {
    const a = await call(createForumR, { method: 'POST', cookie: pm, body: { name: 'Customer ideas', prompt: 'Tell us' } });
    expect(a.status).toBe(201);
    expect(a.body.forum).toMatchObject({ name: 'Customer ideas', slug: 'customer-ideas', prompt: 'Tell us', isMain: false, isArchived: false, postCount: 0, links: [] });
    const clash = await call(createForumR, { method: 'POST', cookie: pm, body: { name: 'Customer  Ideas' } });
    expect([clash.status, clash.body.message]).toEqual([409, 'A forum called Customer  Ideas already exists']);
    expect((await call(createForumR, { method: 'POST', cookie: pm, body: { name: '!!!' } })).status).toBe(400);
    const b = await makeForum(pm, 'Beta forum');
    await makeLink(pm, b, ['VIEW']);
    await call(patchForumR, { method: 'PATCH', cookie: pm, params: { id: a.body.forum.id }, body: { archived: true } });
    const list = await call(listForumsR, { cookie: pm });
    expect(list.body.forums.map((f: { name: string }) => f.name)).toEqual(['Beta forum', 'Customer ideas']);
    expect(list.body.forums[0].links[0]).toMatchObject({ capabilities: ['VIEW'], hasPassword: false, revokedAt: null });
    expect(JSON.stringify(list.body)).not.toMatch(/token|argon/);
  });

  it('main and archive rules (INV-07)', async () => {
    const a = await makeForum(pm, 'A forum', { main: true });
    const b = await makeForum(pm, 'B forum');
    const patch = (id: string, body: Record<string, unknown>) => call(patchForumR, { method: 'PATCH', cookie: pm, params: { id }, body });
    const r = await patch(b, { main: true });
    expect(r.body.forum.isMain).toBe(true);
    const { rows } = await ctx.pg.query<{ name: string }>('SELECT name FROM fh_forum WHERE is_main');
    expect(rows).toEqual([{ name: 'B forum' }]);
    expect((await patch(b, { archived: true })).body.forum).toMatchObject({ isArchived: true, isMain: false });
    const refused = await patch(b, { main: true });
    expect(refused.status).toBe(409);
    expect((await patch(a, { name: 'B forum' })).status).toBe(409); // slug clash on rename
    expect((await patch(a, { name: 'Renamed' })).body.forum.slug).toBe('renamed');
    expect((await patch('0190c3a0-0000-7000-8000-000000000999', { name: 'x' })).status).toBe(404);
  });

  it('share links for archived forums are refused (409); members cannot manage links (404)', async () => {
    const f = await makeForum(pm, 'Gone soon');
    await expect(makeLink(member, f)).rejects.toThrow(/404/);
    await call(patchForumR, { method: 'PATCH', cookie: pm, params: { id: f }, body: { archived: true } });
    await expect(makeLink(pm, f)).rejects.toThrow(/409/);
  });
});

describe('status visibility (FH-1105)', () => {
  it('reads every status (missing rows are not public, never inserted); writes in chip order; unknown keys 400', async () => {
    const before = (await ctx.pg.query('SELECT 1 FROM fh_status_config')).rows.length;
    const r = await call(statusGetR, { cookie: pm });
    expect(r.body.items).toHaveLength(14);
    expect(r.body.items.find((i: { statusKey: string }) => i.statusKey === 'IDEA_BACKLOG')).toEqual({ statusKey: 'IDEA_BACKLOG', isPublic: false, label: null, kind: null });
    expect((await ctx.pg.query('SELECT 1 FROM fh_status_config')).rows.length).toBe(before);
    const put = await call(statusPutR, { method: 'PUT', cookie: pm, body: { items: [{ statusKey: 'IDEA_BACKLOG', isPublic: true, label: ' Later ', kind: null }] } });
    expect(put.status).toBe(200);
    expect(put.body.items.find((i: { statusKey: string }) => i.statusKey === 'IDEA_BACKLOG')).toEqual({ statusKey: 'IDEA_BACKLOG', isPublic: true, label: 'Later', kind: null });
    expect((await call(statusPutR, { method: 'PUT', cookie: pm, body: { items: [{ statusKey: 'IDEA_NOPE', isPublic: true, label: null, kind: null }] } })).status).toBe(400);
    expect((await call(statusPutR, { method: 'PUT', cookie: pm, body: { items: [{ statusKey: 'IDEA_OPEN', isPublic: true, label: 'x'.repeat(61), kind: null }] } })).status).toBe(400);
  });
});

describe('publishing (FH-411 to FH-413)', () => {
  it('409 with no main forum', async () => {
    const id = await createIdea('Lonely');
    const r = await call(previewR, { method: 'POST', cookie: pm, body: { ids: [id] } });
    expect([r.status, r.body.message]).toEqual([409, 'No forum is set as the main forum.']);
  });

  it('preview refuses questions, merged and already-published ideas; truncates text; keeps request order', async () => {
    const forumId = await makeForum(pm, 'Main', { main: true });
    const ok = await createIdea('T'.repeat(200), { description: 'D'.repeat(6000) });
    const q = await createIdea('A question', { ideaType: 'QUESTION' });
    const bug = await createIdea('A bug', { ideaType: 'BUG' });
    const r = await call(previewR, { method: 'POST', cookie: pm, body: { ids: [q, ok, bug, '0190c3a0-0000-7000-8000-000000000999'] } });
    expect(r.body.forum).toEqual({ id: forumId, name: 'Main' });
    expect(r.body.items.map((i: { ideaId: string; reason?: string }) => [i.ideaId, i.reason ?? null])).toEqual([
      [q, 'Questions cannot be published.'], [ok, null], [bug, null], ['0190c3a0-0000-7000-8000-000000000999', 'Not found.']]);
    expect(r.body.items[1].details).toHaveLength(5000);
    const pub = await call(publishR, { method: 'POST', cookie: pm, body: { forumId, items: [{ ideaId: bug, title: 'A bug', details: null }] } });
    expect(pub.body.published).toHaveLength(1);
    const again = await call(previewR, { method: 'POST', cookie: pm, body: { ids: [bug] } });
    expect(again.body.items[0].reason).toBe('Already on a forum.');
  });

  it('publish: staleness 409, duplicate ids 400, over-length rejected, refusals re-checked per idea', async () => {
    const forumId = await makeForum(pm, 'Main', { main: true });
    const a = await createIdea('Alpha');
    const q = await createIdea('Question', { ideaType: 'QUESTION' });
    expect((await call(publishR, { method: 'POST', cookie: pm, body: { forumId: '0190c3a0-0000-7000-8000-000000000999', items: [{ ideaId: a, title: 'x' }] } })).body.message)
      .toBe('The main forum is now Main');
    expect((await call(publishR, { method: 'POST', cookie: pm, body: { forumId, items: [{ ideaId: a, title: 'x' }, { ideaId: a, title: 'y' }] } })).status).toBe(400);
    const long = await call(publishR, { method: 'POST', cookie: pm, body: { forumId, items: [{ ideaId: a, title: 'x'.repeat(201) }] } });
    expect([long.status, long.body.details.field]).toEqual([400, 'items.0.title']);
    const r = await call(publishR, { method: 'POST', cookie: pm, body: { forumId, items: [{ ideaId: q, title: 'Q' }, { ideaId: a, title: ' Alpha, public ', details: 'Public **words**' }] } });
    expect(r.status).toBe(200);
    expect(r.body.skipped).toEqual([{ ideaId: q, reason: 'Questions cannot be published.' }]);
    expect(r.body.published.map((p: { ideaId: string }) => p.ideaId)).toEqual([a]);
    const { rows: [post] } = await ctx.pg.query<Record<string, unknown>>(`
      SELECT p.title, p.details, p.vote_count, p.author_person_id, (SELECT email FROM core_user WHERE id = p.author_user_id) AS author,
        (SELECT count(*)::int FROM fh_vote_event e WHERE e.post_id = p.id AND e.action = 'UP') AS events,
        (SELECT to_value FROM fh_idea_event e WHERE e.idea_id = ${'$1'} AND field = 'published') AS activity,
        (SELECT on_forum FROM fh_idea_rollup WHERE idea_id = ${'$1'}) AS on_forum,
        (SELECT version FROM fh_idea WHERE id = ${'$1'}) AS version
      FROM fh_post p`, [a]);
    expect(post).toEqual({ title: 'Alpha, public', details: 'Public **words**', vote_count: 1, author_person_id: null, author: 'pm@team.test',
      events: 1, activity: 'Published → Main', on_forum: true, version: 2 });
  });

  it('FH-413: the opening vote is the earliest requester with an identity, else the publishing staff member', async () => {
    const forumId = await makeForum(pm, 'Main', { main: true });
    const withPerson = await createIdea('Has requester');
    const noOne = await createIdea('No requester');
    await ctx.pg.query(`INSERT INTO core_person (id, email) VALUES ('0190c3a0-0000-7000-8000-0000000000b1', 'early@client.test'), ('0190c3a0-0000-7000-8000-0000000000b2', 'late@client.test')`);
    await ctx.pg.query(`INSERT INTO fh_insight (id, idea_id, value, person_id, created_at) VALUES
      ('0190c3a0-0000-7000-8000-0000000000b3', $1, 'late', '0190c3a0-0000-7000-8000-0000000000b2', now()),
      ('0190c3a0-0000-7000-8000-0000000000b4', $1, 'early', '0190c3a0-0000-7000-8000-0000000000b1', now() - interval '1 day')`, [withPerson]);
    await call(publishR, { method: 'POST', cookie: pm, body: { forumId, items: [{ ideaId: withPerson, title: 'One' }, { ideaId: noOne, title: 'Two' }] } });
    const { rows } = await ctx.pg.query<{ title: string; voter: string }>(`
      SELECT p.title, COALESCE(pe.email, u.email) AS voter FROM fh_vote v JOIN fh_post p ON p.id = v.post_id
      LEFT JOIN core_person pe ON pe.id = v.person_id LEFT JOIN core_user u ON u.id = v.user_id ORDER BY p.title`);
    expect(rows).toEqual([{ title: 'One', voter: 'early@client.test' }, { title: 'Two', voter: 'pm@team.test' }]);
  });
});

describe('posts administration (FH-1106, FH-1107, FH-1254, D-35)', () => {
  it('lists most votes first with voters and linked ideas; edits; team votes count in totals, not user counts', async () => {
    const forumId = await makeForum(pm, 'Main', { main: true });
    const { token } = await makeLink(pm, forumId);
    const sub = await share(submitR.POST, { token, method: 'POST', path: '/x', form: postForm({ title: 'From a client', email: 'c@client.test', displayName: 'Cara' }) });
    const postId = sub.body.post.id as string;
    const tv = await call(teamVoteR, { method: 'POST', cookie: pm, params: { id: forumId, postId } });
    expect(tv.body).toEqual({ postId, hasVoted: true, voteCount: 2, changed: true });
    const list = await call(forumPostsR, { cookie: pm, params: { id: forumId } });
    expect(list.body.total).toBe(1);
    expect(list.body.posts[0]).toMatchObject({ title: 'From a client', voteCount: 2, author: 'Cara', teamVoted: true });
    expect(list.body.posts[0].voters).toEqual(['Cara', 'pm@team.test (team)']);
    expect(list.body.posts[0].ideas[0]).toMatchObject({ status: 'OPEN', title: 'From a client' });
    // D-35: vote total and distinct voters are separate numbers; the staff vote is not a user.
    const ideaId = list.body.posts[0].ideas[0].id;
    const ideas = await call(ideasR, { cookie: pm, path: `/api/fh/ideas?ids=${ideaId}` });
    expect(ideas.body.rows[0]).toMatchObject({ voteTotal: 2, distinctVoters: 2, userCount: 1 });
    await call(teamUnvoteR, { method: 'DELETE', cookie: pm, params: { id: forumId, postId } });
    const edit = await call(editPostR, { method: 'PATCH', cookie: pm, params: { id: forumId, postId }, body: { title: '  Edited title ', details: 'x'.repeat(10) } });
    expect(edit.body.post).toEqual({ id: postId, title: 'Edited title', details: 'xxxxxxxxxx' });
    expect((await call(editPostR, { method: 'PATCH', cookie: pm, params: { id: forumId, postId }, body: { title: 'x'.repeat(201) } })).status).toBe(400);
    const { rows } = await ctx.pg.query<{ title: string }>('SELECT title FROM fh_idea WHERE id = $1', [ideaId]);
    expect(rows[0].title).toBe('From a client'); // the idea is not changed
    // Voters are never on the public route.
    const pub = await share(forumPublicPostsR.GET, { token, path: '/x' });
    expect(pub.text).not.toMatch(/Cara|team/);
  });

  it('FH-218: post screenshots join the idea panel images', async () => {
    const forumId = await makeForum(pm, 'Main', { main: true });
    const { token } = await makeLink(pm, forumId);
    const sub = await share(submitR.POST, { token, method: 'POST', path: '/x', form: postForm({ title: 'With image' }, [{ bytes: await png(), name: 's.png', type: 'image/png' }]) });
    const ideaId = (await ctx.pg.query<{ idea_id: string }>('SELECT idea_id FROM fh_idea_post WHERE post_id = $1', [sub.body.post.id])).rows[0].idea_id;
    const r = await call(ideaImagesR, { cookie: member, params: { id: ideaId } });
    expect(r.body.images).toHaveLength(1);
    expect(r.body.images[0]).toMatchObject({ postId: sub.body.post.id, insightId: null });
  });
});

describe('D-34 / FH-1108 post delete keeps a linked idea unless it is untouched, judged on both workflows', () => {
  async function setup() {
    const forumId = await makeForum(pm, 'Main', { main: true });
    await ctx.pg.query(`INSERT INTO fh_grant (user_id, can_delete_posts) SELECT id, true FROM core_user WHERE email = 'pm@team.test'`);
    clearPrincipalCache();
    return forumId;
  }
  async function postFor(forumId: string, ideaId: string) {
    const postId = '0190c3a0-0000-7000-8000-' + Math.floor(Math.random() * 1e12).toString(16).padStart(12, '0');
    await ctx.pg.query(`INSERT INTO fh_post (id, forum_id, title, vote_count) VALUES ($1, $2, 'p', 0)`, [postId, forumId]);
    await ctx.pg.query(`INSERT INTO fh_idea_post (idea_id, post_id) VALUES ($1, $2)`, [ideaId, postId]);
    await ctx.pg.query(`INSERT INTO fh_vote_event (id, post_id, action) VALUES (gen_random_uuid(), $1, 'UP')`, [postId]);
    return postId;
  }
  const del = (forumId: string, postId: string, cookie = pm) => call(deletePostR, { method: 'DELETE', cookie, params: { id: forumId, postId } });

  it('needs the post-delete grant: a feedback admin without it and a workspace admin are refused (SEC-02)', async () => {
    const forumId = await makeForum(pm, 'Main', { main: true });
    const postId = await postFor(forumId, await createIdea('x'));
    expect((await del(forumId, postId, pm)).status).toBe(403);
    expect((await del(forumId, postId, admin)).status).toBe(403);
  });

  it('an untouched Open idea and an untouched Open bug are deleted; touched ideas are kept', async () => {
    const forumId = await setup();
    const untouchedIdea = await createIdea('untouched idea');
    const untouchedBug = await createIdea('untouched bug', { ideaType: 'BUG' });
    await ctx.pg.query(`UPDATE fh_idea SET owner_id = NULL WHERE id = ANY($1::uuid[])`, [[untouchedIdea, untouchedBug]]);
    const owned = await createIdea('owned'); // createIdea assigns the creator as owner
    const triaged = await createIdea('triaged bug', { ideaType: 'BUG' });
    await ctx.pg.query(`UPDATE fh_idea SET owner_id = NULL, bug_status = 'TRIAGED' WHERE id = $1`, [triaged]);
    const commented = await createIdea('commented');
    await ctx.pg.query(`UPDATE fh_idea SET owner_id = NULL WHERE id = $1`, [commented]);
    await ctx.pg.query(`INSERT INTO fh_comment (id, idea_id, body) VALUES (gen_random_uuid(), $1, 'note')`, [commented]);
    const manual = await createIdea('manual insight');
    await ctx.pg.query(`UPDATE fh_idea SET owner_id = NULL WHERE id = $1`, [manual]);
    await ctx.pg.query(`INSERT INTO fh_insight (id, idea_id, value, source) VALUES (gen_random_uuid(), $1, 'said', 'MANUAL')`, [manual]);
    const twoPosts = await createIdea('two posts');
    await ctx.pg.query(`UPDATE fh_idea SET owner_id = NULL WHERE id = $1`, [twoPosts]);
    await postFor(forumId, twoPosts);

    for (const [ideaId, expectDeleted] of [[untouchedIdea, true], [untouchedBug, true], [owned, false], [triaged, false], [commented, false], [manual, false], [twoPosts, false]] as const) {
      const postId = await postFor(forumId, ideaId);
      // A forum insight with a screenshot on the idea, to check files go with a deleted idea.
      const insightId = (await ctx.pg.query<{ id: string }>(`INSERT INTO fh_insight (id, idea_id, value, source, source_ref) VALUES (gen_random_uuid(), $1, 'v', 'FORUM', $2) RETURNING id::text`, [ideaId, postId])).rows[0].id;
      await store.put(`fh/insight/${insightId}/f`, Buffer.from('x'), 'image/png');
      await ctx.pg.query(`INSERT INTO core_file (id, module, owner_kind, owner_id, storage_key, content_type, size_bytes, sha256) VALUES (gen_random_uuid(), 'fh', 'insight', $1, $2, 'image/png', 1, 'x')`, [insightId, `fh/insight/${insightId}/f`]);
      const r = await del(forumId, postId);
      expect(r.status).toBe(200);
      expect(r.body.deletedIdeaIds).toEqual(expectDeleted ? [ideaId] : []);
      expect(r.body.keptIdeaIds).toEqual(expectDeleted ? [] : [ideaId]);
      expect((await ctx.pg.query('SELECT 1 FROM fh_idea WHERE id = $1', [ideaId])).rows.length).toBe(expectDeleted ? 0 : 1);
      expect(store.objects.has(`fh/insight/${insightId}/f`)).toBe(!expectDeleted); // INV-17
      expect((await ctx.pg.query('SELECT 1 FROM fh_vote_event WHERE post_id = $1', [postId])).rows).toHaveLength(0);
    }
    const audits = await ctx.pg.query(`SELECT 1 FROM core_audit_log WHERE action = 'fh.post.delete'`);
    expect(audits.rows).toHaveLength(7);
  });

  it('deleting a post removes its screenshots (INV-17) and recomputes the kept idea roll-up', async () => {
    const forumId = await setup();
    const { token } = await makeLink(pm, forumId);
    const sub = await share(submitR.POST, { token, method: 'POST', path: '/x', form: postForm({ title: 'Shot' }, [{ bytes: await png(), name: 's.png', type: 'image/png' }]) });
    const ideaId = (await ctx.pg.query<{ idea_id: string }>('SELECT idea_id FROM fh_idea_post WHERE post_id = $1', [sub.body.post.id])).rows[0].idea_id;
    await ctx.pg.query(`UPDATE fh_idea SET status = 'PLANNED' WHERE id = $1`, [ideaId]);
    expect(store.objects.size).toBe(1);
    const r = await del(forumId, sub.body.post.id);
    expect(r.body).toMatchObject({ deletedIdeaIds: [], keptIdeaIds: [ideaId], filesRemoved: 1 });
    expect(store.objects.size).toBe(0);
    const { rows } = await ctx.pg.query<{ on_forum: boolean; vote_total: number }>('SELECT on_forum, vote_total FROM fh_idea_rollup WHERE idea_id = $1', [ideaId]);
    expect(rows[0]).toEqual({ on_forum: false, vote_total: 0 });
  });
});
