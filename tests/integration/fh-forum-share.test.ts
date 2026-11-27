// P3 public forum on the share pipeline: INV-15, INV-16 contract, byte-identical 404s (SEC-07), submit and identity
// (FH-1211 to FH-1214), votes (FH-1251, FH-1252), D-36 roadmap, PT-19 statements and size, erasure of vote events.
import { beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { freshDb } from '../db';
import { signInAll } from '../fh';
import { makeForum, makeLink, postForm, share, visitorCookie } from '../forum';
import { MemoryStorage, setStorage } from '@/modules/core/files/storage';
import { clearPrincipalCache } from '@/modules/core/auth/principal';
import { clearSettingsCache } from '@/modules/core/settings';
import { PUBLIC_POST_KEYS, PUBLIC_ROADMAP_KEYS } from '@/modules/fh/forum-domain';
import { runErasure } from '@/modules/core/erasure';
import * as forumR from '@/app/api/share/[token]/fh/forum/route';
import * as postsR from '@/app/api/share/[token]/fh/forum/posts/route';
import * as roadmapR from '@/app/api/share/[token]/fh/forum/roadmap/route';
import * as similarR from '@/app/api/share/[token]/fh/forum/similar/route';
import * as submitR from '@/app/api/share/[token]/fh/posts/route';
import * as editR from '@/app/api/share/[token]/fh/posts/[postId]/route';
import * as imagesR from '@/app/api/share/[token]/fh/posts/[postId]/images/route';
import * as voteR from '@/app/api/share/[token]/fh/posts/[postId]/vote/route';
import { PATCH as patchForum } from '@/app/api/fh/forums/[id]/route';
import { call } from '../http';

let ctx: Awaited<ReturnType<typeof freshDb>>;
let admin: string, pm: string;
let store: MemoryStorage;
let forumId: string;

beforeEach(async () => {
  ctx = await freshDb();
  ({ admin, pm } = await signInAll(ctx.pg));
  store = new MemoryStorage();
  setStorage(store);
  forumId = await makeForum(admin, 'Ideas board', { main: true, prompt: 'What would make planning easier?' });
});

const png = (colour = '#0a0') => sharp({ create: { width: 4, height: 4, channels: 3, background: colour } }).png().toBuffer();

async function submit(token: string, fields: Record<string, string>, cookie?: string, images: { bytes: Buffer; name: string; type: string }[] = []) {
  return share(submitR.POST, { token, method: 'POST', path: `/api/share/${token}/fh/posts`, form: postForm(fields, images), cookie });
}
const posts = (token: string, query = '', cookie?: string) =>
  share(postsR.GET, { token, path: `/api/share/${token}/fh/forum/posts${query ? `?${query}` : ''}`, cookie });
const voteOn = (token: string, postId: string, cookie?: string, method = 'POST') =>
  share(method === 'POST' ? voteR.POST : voteR.DELETE, { token, method, path: `/api/share/${token}/fh/posts/${postId}/vote`, params: { postId }, cookie });

describe('access (FH-1201, FH-1202, SEC-07, SEC-08)', () => {
  it('missing, revoked, expired, used-up, archived, capability, wrong method and wrong post answer byte-identical 404s', async () => {
    const live = await makeLink(admin, forumId);
    const revoked = await makeLink(admin, forumId);
    await ctx.pg.query(`UPDATE core_share_link SET revoked_at = now() WHERE id = $1`, [revoked.id]);
    const expired = await makeLink(admin, forumId, ['VIEW'], { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await ctx.pg.query(`UPDATE core_share_link SET expires_at = now() - interval '1 second' WHERE id = $1`, [expired.id]);
    const usedUp = await makeLink(admin, forumId, ['VIEW', 'VOTE'], { maxUses: 1 });
    const viewOnly = await makeLink(admin, forumId, ['VIEW']);
    const otherForum = await makeForum(admin, 'Archive me');
    const archived = await makeLink(admin, otherForum);
    await call(patchForum, { method: 'PATCH', cookie: admin, params: { id: otherForum }, body: { archived: true } });

    const created = await submit(live.token, { title: 'Export to PDF' });
    expect(created.status).toBe(201);
    const postId = created.body.post.id;
    expect((await voteOn(usedUp.token, postId)).status).toBe(200); // spends the only use

    const answers = await Promise.all([
      share(forumR.GET, { token: 'A'.repeat(43) }),
      share(forumR.GET, { token: 'not-a-token' }),
      share(forumR.GET, { token: revoked.token }),
      share(forumR.GET, { token: expired.token }),
      share(forumR.GET, { token: usedUp.token }),
      share(forumR.GET, { token: archived.token }),
      voteOn(viewOnly.token, postId),                                      // capability the link lacks
      share(forumR.POST, { token: live.token, method: 'POST' }),          // wrong method
      share(voteR.GET, { token: live.token, params: { postId } }),
      voteOn(live.token, '0190c3a0-0000-7000-8000-00000000dead'),        // post not in this forum
      voteOn(live.token, 'nope'),
    ]);
    for (const a of answers) {
      expect(a.status).toBe(404);
      expect(a.text).toBe(answers[0].text);
      expect([...a.headers.entries()].sort()).toEqual([...answers[0].headers.entries()].sort());
    }
  });

  it('a post of another forum is never reached through this link (INV-15)', async () => {
    const other = await makeForum(admin, 'Second forum');
    const a = await makeLink(admin, forumId), b = await makeLink(admin, other);
    const p = await submit(b.token, { title: 'Only in the second forum' });
    expect((await voteOn(a.token, p.body.post.id)).status).toBe(404);
    expect((await share(imagesR.GET, { token: a.token, params: { postId: p.body.post.id } })).status).toBe(404);
    expect((await posts(a.token)).body.posts).toEqual([]);
  });

  it('archiving stops links and un-archiving brings them back (FH-1103)', async () => {
    const { token } = await makeLink(admin, forumId);
    await call(patchForum, { method: 'PATCH', cookie: admin, params: { id: forumId }, body: { archived: true } });
    expect((await share(forumR.GET, { token })).status).toBe(404);
    await call(patchForum, { method: 'PATCH', cookie: admin, params: { id: forumId }, body: { archived: false } });
    expect((await share(forumR.GET, { token })).status).toBe(200);
  });

  it('a link stops when its creator is no longer a feedback admin (SEC-08)', async () => {
    const { token } = await makeLink(pm, forumId);
    expect((await share(forumR.GET, { token })).status).toBe(200);
    await ctx.pg.query(`UPDATE core_user SET role = 'MEMBER' WHERE email = 'pm@team.test'`);
    clearPrincipalCache();
    expect((await share(forumR.GET, { token })).status).toBe(404);
  });

  it('password: none 401, wrong 403, right 200; a visitor who knows it is never locked out', async () => {
    const { token } = await makeLink(admin, forumId, ['VIEW'], { password: 'open sesame' });
    expect((await share(forumR.GET, { token })).status).toBe(401);
    expect((await share(forumR.GET, { token, password: 'wrong one' })).status).toBe(403);
    for (let i = 0; i < 15; i++) expect((await share(forumR.GET, { token, password: 'open sesame' })).status).toBe(200);
    for (let i = 0; i < 9; i++) await share(forumR.GET, { token, password: 'wrong one' });
    expect((await share(forumR.GET, { token, password: 'open sesame' })).status).toBe(429); // 10 failures in the window
  });
});

describe('reading (FH-1204 to FH-1208)', () => {
  it('forum meta: name, prompt, the default chip first, capabilities and limits', async () => {
    const { token } = await makeLink(admin, forumId, ['VIEW', 'VOTE']);
    const r = await share(forumR.GET, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ forum: { name: 'Ideas board', prompt: 'What would make planning easier?' }, statusChips: ['Under consideration'], can: { submit: false, vote: true } });
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('status labels, the status filter, sort tabs and search', async () => {
    const { token } = await makeLink(admin, forumId);
    const a = (await submit(token, { title: 'Alpha gantt export', details: 'Would love **PDF**' })).body.post;
    const b = (await submit(token, { title: 'Beta calendar sync' })).body.post;
    const c = (await submit(token, { title: 'Gamma offline mode' })).body.post;
    const ideaOf = async (postId: string) => (await ctx.pg.query<{ idea_id: string }>('SELECT idea_id FROM fh_idea_post WHERE post_id = $1', [postId])).rows[0].idea_id;
    await ctx.pg.query(`UPDATE fh_idea SET status = 'PLANNED' WHERE id = $1`, [await ideaOf(b.id)]);
    await ctx.pg.query(`UPDATE fh_idea SET status = 'COMPLETE' WHERE id = $1`, [await ideaOf(c.id)]);
    await ctx.pg.query(`UPDATE fh_post SET vote_count = 5 WHERE id = $1`, [a.id]);

    const meta = await share(forumR.GET, { token });
    expect(meta.body.statusChips).toEqual(['Under consideration', 'Planned', 'Complete']);
    const all = (await posts(token, 'sort=top')).body.posts as { id: string; statusLabel: string; statusKind: string | null }[];
    expect(all.map((p) => p.id)[0]).toBe(a.id);
    expect(Object.fromEntries(all.map((p) => [p.id, [p.statusLabel, p.statusKind]]))).toEqual({
      [a.id]: ['Under consideration', null], [b.id]: ['Planned', null], [c.id]: ['Complete', 'complete'],
    });
    expect((await posts(token, 'sort=complete')).body.posts.map((p: { id: string }) => p.id)).toEqual([c.id]);
    expect((await posts(token, `status=${encodeURIComponent('Planned')}&status=${encodeURIComponent('Under consideration')}`)).body.posts.map((p: { id: string }) => p.id).sort())
      .toEqual([a.id, b.id].sort());
    expect((await posts(token, 'q=PDF')).body.posts.map((p: { id: string }) => p.id)).toEqual([a.id]);
    expect((await posts(token, 'sort=new')).body.posts.map((p: { id: string }) => p.id)).toEqual([c.id, b.id, a.id]);
  });

  it('a non-public status reads as the default label (INV-16)', async () => {
    const { token } = await makeLink(admin, forumId);
    const p = (await submit(token, { title: 'Hidden status' })).body.post;
    await ctx.pg.query(`UPDATE fh_idea SET status = 'UNDER_REVIEW' WHERE id = (SELECT idea_id FROM fh_idea_post WHERE post_id = $1)`, [p.id]);
    const r = await posts(token);
    expect(r.body.posts[0].statusLabel).toBe('Under consideration');
    expect(r.text).not.toMatch(/UNDER_REVIEW|Under review/);
  });

  it('similar posts while typing (FH-1211) need SUBMIT and spend no use', async () => {
    const { id, token } = await makeLink(admin, forumId, ['VIEW', 'SUBMIT'], { maxUses: 5 });
    await submit(token, { title: 'Export the gantt chart to PDF' });
    const before = (await ctx.pg.query<{ use_count: number }>('SELECT use_count FROM core_share_link WHERE id = $1', [id])).rows[0].use_count;
    const r = await share(similarR.GET, { token, path: `/api/share/${token}/fh/forum/similar?title=${encodeURIComponent('export gantt chart pdf')}` });
    expect(r.status).toBe(200);
    expect(r.body.posts).toHaveLength(1);
    const after = (await ctx.pg.query<{ use_count: number }>('SELECT use_count FROM core_share_link WHERE id = $1', [id])).rows[0].use_count;
    expect(after).toBe(before);
    const viewOnly = await makeLink(admin, forumId, ['VIEW']);
    expect((await share(similarR.GET, { token: viewOnly.token, path: '/x?title=export' })).status).toBe(404);
  });

  it('D-36: the public roadmap shows the public summary, never the internal description, and only public statuses', async () => {
    const { token } = await makeLink(admin, forumId);
    await ctx.pg.query(`
      INSERT INTO fh_idea (id, title, description, public_summary, status, start_date, due_date) VALUES
        ('0190c3a0-0000-7000-8000-0000000000e1', 'Planned thing', 'INTERNAL ONLY: margin plan', 'Coming in spring', 'PLANNED', '2026-02-01', '2026-02-10'),
        ('0190c3a0-0000-7000-8000-0000000000e2', 'No summary', 'INTERNAL ONLY: secret', NULL, 'IN_PROGRESS', '2026-03-01', NULL),
        ('0190c3a0-0000-7000-8000-0000000000e3', 'Under review thing', 'INTERNAL ONLY', 'x', 'UNDER_REVIEW', '2026-03-01', NULL)`);
    // UNDER_REVIEW is not a roadmap status; make IN_PROGRESS non-public to prove the filter.
    const r = await share(roadmapR.GET, { token, path: `/api/share/${token}/fh/forum/roadmap` });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('INTERNAL ONLY');
    const items = r.body.batches.flatMap((b: { items: unknown[] }) => b.items);
    expect(items.map((i: { title: string }) => i.title)).toEqual(['Planned thing', 'No summary']);
    expect(items[0]).toMatchObject({ summary: 'Coming in spring', statusLabel: 'Planned', voterCount: 0 });
    expect(items[1].summary).toBeNull();
    for (const i of items) expect(Object.keys(i).sort()).toEqual([...PUBLIC_ROADMAP_KEYS].sort());
    // Release batches: due 10 Feb 2026 ships with the 16 Feb train (anchor 5 Jan, 21 days); undated last.
    expect(r.body.batches.map((b: { releaseDate: string | null }) => b.releaseDate)).toEqual(['2026-02-16', null]);
    await ctx.pg.query(`UPDATE fh_status_config SET is_public = false WHERE status_key = 'IDEA_IN_PROGRESS'`);
    const r2 = await share(roadmapR.GET, { token });
    expect(r2.body.batches.flatMap((b: { items: { title: string }[] }) => b.items.map((i) => i.title))).toEqual(['Planned thing']);
  });
});

describe('INV-16 share contract: no internal field leaves a forum share route', () => {
  it('every response has exactly the public keys and none of the internal values', async () => {
    const { token } = await makeLink(admin, forumId);
    const cookie = visitorCookie((await submit(token, { title: 'Contract post', details: 'Visible details', email: 'ann@client.test', displayName: 'Ann Client' }, undefined, [{ bytes: await png(), name: 'a.png', type: 'image/png' }])).setCookie);
    const post = (await posts(token, '', cookie)).body.posts[0];
    // Internal data on the linked idea: owner, theme, comment, internal description, status, requester.
    const ideaId = (await ctx.pg.query<{ idea_id: string }>('SELECT idea_id FROM fh_idea_post WHERE post_id = $1', [post.id])).rows[0].idea_id;
    const owner = (await ctx.pg.query<{ id: string }>(`SELECT id FROM core_user WHERE email = 'pm@team.test'`)).rows[0].id;
    await ctx.pg.query(`UPDATE core_user SET full_name = 'Owner Name Secret' WHERE id = $1`, [owner]);
    await ctx.pg.query(`UPDATE fh_idea SET owner_id = $2, description = 'INTERNAL DESCRIPTION', status = 'PLANNED', start_date = '2026-02-01',
      public_summary = 'Public words' WHERE id = $1`, [ideaId, owner]);
    await ctx.pg.query(`INSERT INTO fh_theme (id, name) VALUES ('0190c3a0-0000-7000-8000-0000000000c1', 'Theme Secret')`);
    await ctx.pg.query(`INSERT INTO fh_idea_theme (idea_id, theme_id) VALUES ($1, '0190c3a0-0000-7000-8000-0000000000c1')`, [ideaId]);
    await ctx.pg.query(`INSERT INTO fh_comment (id, idea_id, author_id, body) VALUES ('0190c3a0-0000-7000-8000-0000000000c2', $1, $2, 'COMMENT SECRET')`, [ideaId, owner]);

    const responses = [
      await share(forumR.GET, { token, cookie }),
      await posts(token, '', cookie),
      await share(roadmapR.GET, { token, cookie }),
      await share(similarR.GET, { token, cookie, path: '/x?title=Contract%20post' }),
      await share(imagesR.GET, { token, cookie, params: { postId: post.id } }),
      await share(editR.PATCH, { token, cookie, method: 'PATCH', params: { postId: post.id }, json: { title: 'Contract post edited', details: 'Visible details' } }),
      await voteOn(token, post.id, cookie, 'DELETE'),
      await voteOn(token, post.id, cookie),
      await submit(token, { title: 'Second contract post' }, cookie),
    ];
    for (const r of responses) {
      expect(r.status).toBeLessThan(300);
      for (const secret of ['INTERNAL DESCRIPTION', 'Owner Name Secret', 'Theme Secret', 'COMMENT SECRET', 'ann@client.test', 'Ann Client', 'PLANNED', 'pm@team.test', 'owner@example.com']) {
        expect(r.text).not.toContain(secret);
      }
      expect(r.text).not.toMatch(/"(status|bugStatus|ownerId|owner|themeIds|themes|author|authorPersonId|voters|email|description|comments)"/);
    }
    const [meta, list, roadmap, similar, images, edited, unvoted, voted, created] = responses.map((r) => r.body);
    expect(Object.keys(meta).sort()).toEqual(['can', 'forum', 'limits', 'statusChips']);
    expect(Object.keys(meta.forum).sort()).toEqual(['name', 'prompt']);
    expect(Object.keys(list).sort()).toEqual(['nextCursor', 'posts']);
    for (const p of [...list.posts, ...similar.posts, edited.post, created.post]) expect(Object.keys(p).sort()).toEqual([...PUBLIC_POST_KEYS].sort());
    expect(Object.keys(roadmap)).toEqual(['batches']);
    for (const b of roadmap.batches) {
      expect(Object.keys(b).sort()).toEqual(['items', 'releaseDate']);
      for (const i of b.items) expect(Object.keys(i).sort()).toEqual([...PUBLIC_ROADMAP_KEYS].sort());
    }
    expect(roadmap.batches[0].items[0].summary).toBe('Public words');
    expect(Object.keys(images)).toEqual(['images']);
    expect(Object.keys(images.images[0]).sort()).toEqual(['id', 'url']);
    for (const v of [unvoted, voted]) expect(Object.keys(v).sort()).toEqual(['changed', 'hasVoted', 'postId', 'voteCount']);
  });
});

describe('submitting (FH-1211 to FH-1214)', () => {
  it('one transaction: post with one vote, a born-reviewed Feature request, history, link, Forum insight, person and roll-up', async () => {
    const { token } = await makeLink(admin, forumId);
    const r = await submit(token, { title: '  Dark mode  ', details: 'Please\r\n\r\n\r\nadd it' }, undefined, [{ bytes: await png(), name: 'shot.png', type: 'image/png' }]);
    expect(r.status).toBe(201);
    expect(r.body.post).toMatchObject({ title: 'Dark mode', details: 'Please\n\nadd it', voteCount: 1, hasVoted: true, isMine: true, imageCount: 1 });
    expect(r.setCookie).toMatch(/^pet_visitor=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/api\/share\/; Max-Age=31536000/);
    const { rows: [idea] } = await ctx.pg.query<Record<string, unknown>>(`
      SELECT i.idea_type, i.status, i.bug_status, i.owner_id, i.reviewed_at IS NOT NULL AS reviewed, i.description,
             (SELECT count(*)::int FROM fh_status_change s WHERE s.idea_id = i.id AND s.from_status IS NULL AND s.to_status = 'IDEA_OPEN') AS hist,
             (SELECT source FROM fh_insight s WHERE s.idea_id = i.id) AS source,
             (SELECT source_ref FROM fh_insight s WHERE s.idea_id = i.id) AS source_ref,
             (SELECT count(*)::int FROM fh_idea_person pp WHERE pp.idea_id = i.id) AS people,
             r.vote_total, r.distinct_voters, r.on_forum, r.user_count
      FROM fh_idea i JOIN fh_idea_rollup r ON r.idea_id = i.id`);
    expect(idea).toMatchObject({ idea_type: 'FEATURE_REQUEST', status: 'OPEN', bug_status: null, owner_id: null, reviewed: true, description: 'Please\n\nadd it',
      hist: 1, source: 'FORUM', source_ref: r.body.post.id, people: 1, vote_total: 1, distinct_voters: 1, on_forum: true, user_count: 1 });
    const { rows: [ev] } = await ctx.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM fh_vote_event WHERE action = 'UP'`);
    expect(ev.n).toBe(1);
    const file = await ctx.pg.query<{ storage_key: string; owner_kind: string }>('SELECT storage_key, owner_kind FROM core_file');
    expect(file.rows[0]).toMatchObject({ owner_kind: 'post' });
    expect(store.objects.has(file.rows[0].storage_key)).toBe(true);
    const imgs = await share(imagesR.GET, { token, params: { postId: r.body.post.id } });
    expect(imgs.body.images).toHaveLength(1);
  });

  it('over-length is rejected, never truncated; a bad image type stores nothing', async () => {
    const { token } = await makeLink(admin, forumId);
    const r = await submit(token, { title: 'x'.repeat(201) });
    expect([r.status, r.body.details?.field]).toEqual([400, 'title']);
    const bad = await submit(token, { title: 'With a GIF' }, undefined, [{ bytes: Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary'), name: 'a.gif', type: 'image/gif' }]);
    expect(bad.status).toBe(415);
    expect((await ctx.pg.query('SELECT 1 FROM fh_post')).rows).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  });

  it('storage failing mid-transaction removes the uploaded screenshots', async () => {
    const { token } = await makeLink(admin, forumId);
    await ctx.pg.query(`ALTER TABLE fh_insight ADD CONSTRAINT boom CHECK (value <> 'explode')`);
    const r = await submit(token, { title: 'explode' }, undefined, [{ bytes: await png(), name: 'a.png', type: 'image/png' }]);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(store.objects.size).toBe(0);
    expect((await ctx.pg.query('SELECT 1 FROM fh_post')).rows).toHaveLength(0);
  });

  it('FH-1213 identities: cookie on the first write; an owned email wins; a second email gets a new identity', async () => {
    const { token } = await makeLink(admin, forumId);
    await ctx.pg.query(`INSERT INTO core_company (id, name, domain) VALUES ('0190c3a0-0000-7000-8000-0000000000d1', 'Client Co', 'client.test')`);
    const first = await submit(token, { title: 'One', email: 'Ann@Client.test', displayName: 'Ann' });
    const cookie = visitorCookie(first.setCookie);
    const people = async () => (await ctx.pg.query<{ email: string | null; company_id: string | null; has_cookie: boolean }>(
      'SELECT email, company_id::text, cookie_token_hash IS NOT NULL AS has_cookie FROM core_person ORDER BY created_at, id')).rows;
    expect(await people()).toEqual([{ email: 'ann@client.test', company_id: '0190c3a0-0000-7000-8000-0000000000d1', has_cookie: true }]);
    expect((await ctx.pg.query('SELECT 1 FROM fh_idea_company')).rows).toHaveLength(1); // INV-13

    const second = await submit(token, { title: 'Two', email: 'bob@client.test' }, cookie);
    expect(second.setCookie).toBeNull();
    expect(second.body.post.isMine).toBe(false); // attributed to the new identity, not this browser's
    expect((await people()).map((p) => [p.email, p.has_cookie])).toEqual([['ann@client.test', true], ['bob@client.test', false]]);

    // A fresh browser using Ann's email: the post is Ann's, the browser gets its own email-less identity.
    const third = await submit(token, { title: 'Three', email: 'ann@client.test' });
    expect(third.setCookie).not.toBeNull();
    const { rows } = await ctx.pg.query<{ email: string | null }>(`SELECT p.email FROM fh_post fp JOIN core_person p ON p.id = fp.author_person_id WHERE fp.title = 'Three'`);
    expect(rows[0].email).toBe('ann@client.test');
    expect(await people()).toHaveLength(3);
  });

  it('a visitor edits only their own post (FH-1214); the idea is not changed', async () => {
    const { token } = await makeLink(admin, forumId);
    const mine = await submit(token, { title: 'Mine' });
    const cookie = visitorCookie(mine.setCookie);
    const theirs = await submit(token, { title: 'Theirs' });
    const edit = (postId: string, c?: string) => share(editR.PATCH, { token, cookie: c, method: 'PATCH', params: { postId }, json: { title: 'Changed', details: null } });
    expect((await edit(theirs.body.post.id, cookie)).status).toBe(404);
    expect((await edit(mine.body.post.id)).status).toBe(404);
    const ok = await edit(mine.body.post.id, cookie);
    expect(ok.status).toBe(200);
    expect(ok.body.post).toMatchObject({ title: 'Changed', isMine: true });
    const { rows } = await ctx.pg.query<{ title: string }>(`SELECT title FROM fh_idea ORDER BY created_at LIMIT 1`);
    expect(rows[0].title).toBe('Mine');
  });

  it('a VIEW and VOTE link cannot submit', async () => {
    const { token } = await makeLink(admin, forumId, ['VIEW', 'VOTE']);
    expect((await submit(token, { title: 'Nope' })).status).toBe(404);
  });
});

describe('voting (FH-1251 to FH-1253)', () => {
  it('upvote once, duplicates skipped, undo writes UNDO and roll-ups follow', async () => {
    const { token } = await makeLink(admin, forumId);
    const post = (await submit(token, { title: 'Vote on me' })).body.post;
    const v1 = await voteOn(token, post.id);
    expect(v1.body).toEqual({ postId: post.id, hasVoted: true, voteCount: 2, changed: true });
    const cookie = visitorCookie(v1.setCookie);
    expect((await voteOn(token, post.id, cookie)).body).toEqual({ postId: post.id, hasVoted: true, voteCount: 2, changed: false });
    expect((await posts(token, '', cookie)).body.posts[0].hasVoted).toBe(true);
    const rollup = async () => (await ctx.pg.query<{ vote_total: number; distinct_voters: number }>('SELECT vote_total, distinct_voters FROM fh_idea_rollup')).rows[0];
    expect(await rollup()).toEqual({ vote_total: 2, distinct_voters: 2 });
    expect((await voteOn(token, post.id, cookie, 'DELETE')).body).toEqual({ postId: post.id, hasVoted: false, voteCount: 1, changed: true });
    expect(await rollup()).toEqual({ vote_total: 1, distinct_voters: 1 });
    const events = await ctx.pg.query<{ action: string }>('SELECT action FROM fh_vote_event ORDER BY created_at, id');
    expect(events.rows.map((e) => e.action)).toEqual(['UP', 'UP', 'UNDO']);
    // INV-04
    const { rows } = await ctx.pg.query<{ ok: boolean }>('SELECT bool_and(p.vote_count = (SELECT count(*) FROM fh_vote v WHERE v.post_id = p.id)) AS ok FROM fh_post p');
    expect(rows[0].ok).toBe(true);
  });

  it('removing a vote with no identity is a no-op that creates none', async () => {
    const { token } = await makeLink(admin, forumId);
    const post = (await submit(token, { title: 'Untouched' })).body.post;
    const before = (await ctx.pg.query('SELECT 1 FROM core_person')).rows.length;
    const r = await voteOn(token, post.id, undefined, 'DELETE');
    expect(r.body).toEqual({ postId: post.id, hasVoted: false, voteCount: 1, changed: false });
    expect(r.setCookie).toBeNull();
    expect((await ctx.pg.query('SELECT 1 FROM core_person')).rows.length).toBe(before);
  });

  it('concurrent double vote from one identity counts once (INV-03)', async () => {
    const { token } = await makeLink(admin, forumId);
    const post = (await submit(token, { title: 'Race' })).body.post;
    const cookie = visitorCookie((await voteOn(token, (await submit(token, { title: 'Other' })).body.post.id)).setCookie);
    const [a, b] = await Promise.all([voteOn(token, post.id, cookie), voteOn(token, post.id, cookie)]);
    expect([a.body.changed, b.body.changed].sort()).toEqual([false, true]);
    const { rows } = await ctx.pg.query<{ vote_count: number }>('SELECT vote_count FROM fh_post WHERE id = $1', [post.id]);
    expect(rows[0].vote_count).toBe(2);
  });

  it('per-identity vote limit answers 429 before a use is spent (SEC-27)', async () => {
    const { token } = await makeLink(admin, forumId);
    const post = (await submit(token, { title: 'Limit' })).body.post;
    const cookie = visitorCookie((await voteOn(token, post.id)).setCookie);
    const person = (await ctx.pg.query<{ id: string }>('SELECT id FROM core_person WHERE cookie_token_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1')).rows[0].id;
    const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    await ctx.pg.query(`INSERT INTO core_rate_window (key, window_start, count) VALUES ($1, $2, 120)`, [`share:fh-vote:person:${person}`, windowStart]);
    const r = await voteOn(token, post.id, cookie, 'DELETE');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).not.toBeNull();
  });
});

describe('erasure (SEC-20) clears the person from vote events', () => {
  it('votes go, counts are recounted, events keep no person', async () => {
    const { token } = await makeLink(admin, forumId);
    const post = (await submit(token, { title: 'Erase me', email: 'gone@client.test' })).body.post;
    const person = (await ctx.pg.query<{ id: string }>(`SELECT id FROM core_person WHERE email = 'gone@client.test'`)).rows[0].id;
    const out = await runErasure({ kind: 'system', id: null }, [person]);
    expect(out.erased).toEqual([person]);
    expect((await ctx.pg.query<{ n: number }>('SELECT count(*)::int AS n FROM fh_vote_event WHERE person_id IS NOT NULL')).rows[0].n).toBe(0);
    expect((await ctx.pg.query<{ vote_count: number; author: string | null }>('SELECT vote_count, author_person_id AS author FROM fh_post WHERE id = $1', [post.id])).rows[0])
      .toEqual({ vote_count: 0, author: null });
  });
});

describe('PT-19 public forum page (PERF-B20): ≤ 3 statements and ≤ 150 KB, the same at 10×', () => {
  async function seedPosts(count: number, votes: number) {
    await ctx.pg.query(`INSERT INTO core_person (id, email)
      SELECT ('0190c3a1-0000-7000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, 'p' || g || '@client.test' FROM generate_series(1, 200) g`);
    await ctx.pg.query(`INSERT INTO fh_post (id, forum_id, title, details, created_at)
      SELECT ('0190c3ab-0000-7000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, $1, 'Post number ' || g, 'Some details about request ' || g,
             now() - (g || ' hours')::interval FROM generate_series(1, ${count}) g`, [forumId]);
    await ctx.pg.query(`INSERT INTO fh_vote (id, post_id, person_id)
      SELECT gen_random_uuid(), ('0190c3ab-0000-7000-8000-' || lpad(to_hex(1 + g % ${count}), 12, '0'))::uuid,
             ('0190c3a1-0000-7000-8000-' || lpad(to_hex(1 + (g / ${count}) % 200), 12, '0'))::uuid
      FROM generate_series(0, ${votes - 1}) g ON CONFLICT DO NOTHING`);
    await ctx.pg.query(`UPDATE fh_post p SET vote_count = (SELECT count(*) FROM fh_vote v WHERE v.post_id = p.id)`);
  }

  async function measure() {
    clearSettingsCache();
    const { token } = await makeLink(admin, forumId);
    const out: Record<string, { statements: number; bytes: number }> = {};
    for (const [name, h, path] of [
      ['forum', forumR.GET, `/api/share/${token}/fh/forum`],
      ['posts', postsR.GET, `/api/share/${token}/fh/forum/posts?sort=trending`],
      ['top', postsR.GET, `/api/share/${token}/fh/forum/posts?sort=top&cursor=50`],
      ['roadmap', roadmapR.GET, `/api/share/${token}/fh/forum/roadmap`],
    ] as const) {
      const r = await share(h, { token, path });
      expect(r.status).toBe(200);
      out[name] = { statements: r.statements, bytes: Buffer.byteLength(r.text) };
    }
    return out;
  }

  it('300 posts and 20,000 votes, then 3,000 posts', async () => {
    await seedPosts(300, 20_000);
    const base = await measure();
    for (const m of Object.values(base)) {
      expect(m.statements).toBeLessThanOrEqual(3);
      expect(m.bytes).toBeLessThanOrEqual(150 * 1024);
    }
    ctx = await freshDb();
    ({ admin } = await signInAll(ctx.pg));
    forumId = await makeForum(admin, 'Ideas board', { main: true });
    await seedPosts(3_000, 20_000);
    const big = await measure();
    for (const k of Object.keys(base)) expect(big[k].statements).toBe(base[k].statements);
    for (const m of Object.values(big)) expect(m.bytes).toBeLessThanOrEqual(150 * 1024);
  }, 120_000);
});
