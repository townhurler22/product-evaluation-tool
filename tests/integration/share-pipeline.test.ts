// SEC-04, SEC-06 to SEC-12. Forum and board resolvers arrive in P3/P4; a stand-in resolver tests the pipeline now.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { freshDb } from '../db';
import { call } from '../http';
import { registerShareResolver, shareRoute, type Capability } from '@/modules/core/share/pipeline';
import { registerShareManagePolicy } from '@/modules/core/share/links';
import { GET as listLinks, POST as createLink } from '@/app/api/core/share-links/route';
import { POST as revokeLink } from '@/app/api/core/share-links/[id]/revoke/route';
import { requestMagicLink } from '@/modules/core/auth/sign-in';
import { GET as callback } from '@/app/api/auth/callback/route';
import { GET as meRoute } from '@/app/api/me/route';
import { POST as magicLinkRoute } from '@/app/api/auth/magic-link/route';
import { clearPrincipalCache } from '@/modules/core/auth/principal';

const FORUM_ID = '0190c3a0-0000-7000-8000-0000000000f1';
let forumExists = true;

beforeAll(() => {
  registerShareResolver('fh', async (link) =>
    forumExists && link.target_id === FORUM_ID && link.creator_status === 'ACTIVE'
      ? { targetId: link.target_id, grant: ['VIEW', 'SUBMIT', 'VOTE'] }
      : null);
  registerShareManagePolicy('fh', 'forum', async (p) => p.isFeedbackAdmin);
});

const viewRoute = shareRoute({ module: 'fh', capability: 'VIEW', route: 'GET /api/share/:token/fh/forum' },
  async ({ share }) => ({ forumId: share.targetId }));
const voteRoute = shareRoute({ module: 'fh', capability: 'VOTE', route: 'POST /api/share/:token/fh/posts/:postId/vote' },
  async () => ({ voted: true }));
const boardRoute = shareRoute({ module: 'jb', capability: 'VIEW', route: 'GET /api/share/:token/jb/board' }, async () => ({}));

async function hitShare(handler: typeof viewRoute, token: string, opts: { method?: string; password?: string; origin?: string | null } = {}) {
  const headers = new Headers({ 'x-real-ip': '192.0.2.44' });
  if (opts.password) headers.set('x-share-password', opts.password);
  const method = opts.method ?? 'GET';
  if (method !== 'GET' && opts.origin !== null) headers.set('origin', opts.origin ?? 'http://localhost:3000');
  const res = await handler(new NextRequest(new URL(`/api/share/${token}/fh/forum`, 'http://localhost:3000'), { method, headers }),
    { params: Promise.resolve({ token }) });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

let ctx: Awaited<ReturnType<typeof freshDb>>;
let adminCookie: string;

async function signIn(email: string) {
  const link = await requestMagicLink({ email, ipHash: null, origin: 'http://x' });
  const res = await call(callback, { path: `/api/auth/callback?token=${encodeURIComponent(new URL(link!).searchParams.get('token')!)}` });
  return res.setCookie!.split(';')[0];
}

async function makeLink(capabilities: Capability[], extra: Record<string, unknown> = {}) {
  const r = await call(createLink, { method: 'POST', cookie: adminCookie, body: { module: 'fh', targetKind: 'forum', targetId: FORUM_ID, capabilities, ...extra } });
  expect(r.status).toBe(201);
  return { id: r.body.link.id as string, token: (r.body.url as string).split('/').pop()! };
}

beforeEach(async () => {
  ctx = await freshDb();
  forumExists = true;
  adminCookie = await signIn('owner@example.com');
});

describe('uniform 404 (SEC-07)', () => {
  it('missing, malformed, revoked, expired, used-up and wrong-module links answer the same bytes', async () => {
    const { token: live } = await makeLink(['VOTE']);
    const revoked = await makeLink(['VOTE']);
    await ctx.pg.query(`UPDATE core_share_link SET revoked_at = now() WHERE id = $1`, [revoked.id]);
    const expired = await makeLink(['VIEW'], { expiresAt: new Date(Date.now() + 1000).toISOString() });
    await ctx.pg.query(`UPDATE core_share_link SET expires_at = now() - interval '1 second' WHERE id = $1`, [expired.id]);
    const usedUp = await makeLink(['VOTE'], { maxUses: 1 });
    expect((await hitShare(voteRoute, usedUp.token, { method: 'POST' })).status).toBe(200);

    const answers = await Promise.all([
      hitShare(viewRoute, 'A'.repeat(43)),               // missing
      hitShare(viewRoute, 'short'),                      // malformed
      hitShare(viewRoute, revoked.token),
      hitShare(viewRoute, expired.token),
      hitShare(viewRoute, usedUp.token),
      hitShare(boardRoute, live),                        // wrong module
    ]);
    for (const a of answers) {
      expect(a.status).toBe(404);
      expect(a.text).toBe(answers[0].text);
      expect([...a.headers.entries()].sort()).toEqual([...answers[0].headers.entries()].sort());
    }
  });

  it('a capability the link lacks is the same 404', async () => {
    const { token } = await makeLink(['VIEW']);
    expect((await hitShare(viewRoute, token)).status).toBe(200);
    const vote = await hitShare(voteRoute, token, { method: 'POST' });
    expect([vote.status, vote.text]).toEqual([404, (await hitShare(viewRoute, 'B'.repeat(43))).text]);
  });

  it('resolvers fail closed: target gone or creator deactivated → 404 (SEC-08)', async () => {
    const { token } = await makeLink(['VIEW']);
    forumExists = false;
    expect((await hitShare(viewRoute, token)).status).toBe(404);
    forumExists = true;
    await ctx.pg.query(`UPDATE core_user SET status = 'DISABLED'`);
    expect((await hitShare(viewRoute, token)).status).toBe(404);
  });
});

describe('capabilities and uses', () => {
  it('a non-VIEW use is consumed atomically before the handler, with a hashed IP row', async () => {
    const { id, token } = await makeLink(['VOTE'], { maxUses: 2 });
    expect((await hitShare(voteRoute, token, { method: 'POST' })).status).toBe(200);
    expect((await hitShare(voteRoute, token, { method: 'POST' })).status).toBe(200);
    expect((await hitShare(voteRoute, token, { method: 'POST' })).status).toBe(404);
    const { rows } = await ctx.pg.query<{ use_count: number }>('SELECT use_count FROM core_share_link WHERE id = $1', [id]);
    expect(rows[0].use_count).toBe(2);
    const uses = await ctx.pg.query<{ ip_hash: string }>('SELECT ip_hash FROM core_share_link_use');
    expect(uses.rows).toHaveLength(2);
    expect(uses.rows[0].ip_hash).not.toContain('192.0.2.44');
  });

  it('VIEW never consumes a use', async () => {
    const { id, token } = await makeLink(['VIEW']);
    await hitShare(viewRoute, token);
    await hitShare(viewRoute, token);
    const { rows } = await ctx.pg.query<{ use_count: number }>('SELECT use_count FROM core_share_link WHERE id = $1', [id]);
    expect(rows[0].use_count).toBe(0);
  });

  it('board links grant VIEW only (SEC-09)', async () => {
    registerShareManagePolicy('jb', 'board', async () => true);
    const r = await call(createLink, { method: 'POST', cookie: adminCookie, body: { module: 'jb', targetKind: 'board', targetId: FORUM_ID, capabilities: ['VOTE'] } });
    expect(r.status).toBe(422);
  });
});

describe('passwords (SEC-07 step 4, SEC-24)', () => {
  it('none → 401, wrong → 403, right → 200; stored as Argon2id', async () => {
    const { id, token } = await makeLink(['VIEW'], { password: 'correct horse' });
    expect((await hitShare(viewRoute, token)).status).toBe(401);
    expect((await hitShare(viewRoute, token, { password: 'nope nope' })).status).toBe(403);
    expect((await hitShare(viewRoute, token, { password: 'correct horse' })).status).toBe(200);
    const { rows } = await ctx.pg.query<{ password_hash: string }>('SELECT password_hash FROM core_share_link WHERE id = $1', [id]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('10 attempts per 15 minutes per IP and link, then 429', async () => {
    const { token } = await makeLink(['VIEW'], { password: 'correct horse' });
    for (let i = 0; i < 10; i++) await hitShare(viewRoute, token, { password: 'wrong guess' });
    expect((await hitShare(viewRoute, token, { password: 'correct horse' })).status).toBe(429);
  });
});

describe('token hygiene (SEC-12)', () => {
  it('share answers send no-referrer, noindex and no-store', async () => {
    const { token } = await makeLink(['VIEW']);
    const r = await hitShare(viewRoute, token);
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('only the token hash is stored (OD-04)', async () => {
    const { token } = await makeLink(['VIEW']);
    const { rows } = await ctx.pg.query('SELECT * FROM core_share_link');
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});

describe('link management', () => {
  it('needs the module policy: a member sees 404', async () => {
    await ctx.pg.query(`UPDATE core_setting SET value = '["team.test"]' WHERE key = 'auth.allowed_domains'`);
    const member = await signIn('m@team.test');
    const r = await call(createLink, { method: 'POST', cookie: member, body: { module: 'fh', targetKind: 'forum', targetId: FORUM_ID, capabilities: ['VIEW'] } });
    expect(r.status).toBe(404);
  });

  it('lists without tokens or password hashes; revoke is idempotent and audited', async () => {
    const { id } = await makeLink(['VIEW'], { password: 'correct horse' });
    const list = await call(listLinks, { cookie: adminCookie, path: `/api/core/share-links?module=fh&targetKind=forum&targetId=${FORUM_ID}` });
    expect(list.body.links[0]).toMatchObject({ id, hasPassword: true });
    expect(JSON.stringify(list.body)).not.toMatch(/argon2|token/);
    const revoke = () => revokeLink(new NextRequest(new URL(`/api/core/share-links/${id}/revoke`, 'http://localhost:3000'),
      { method: 'POST', headers: { cookie: adminCookie, origin: 'http://localhost:3000' } }), { params: Promise.resolve({ id }) });
    const r1 = await revoke();
    const r2 = await revoke();
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const { rows } = await ctx.pg.query(`SELECT count(*)::int AS n FROM core_audit_log WHERE action = 'core.share_link.revoke'`);
    expect(rows).toEqual([{ n: 1 }]);
  });
});

describe('cross-site request protection (SEC-04)', () => {
  it('staff POST without a matching Origin is 403', async () => {
    const r = await call(magicLinkRoute, { method: 'POST', body: { email: 'owner@example.com' }, headers: { origin: 'https://evil.test' } });
    expect(r.status).toBe(403);
  });

  it('staff POST with Sec-Fetch-Site same-origin and no Origin is allowed', async () => {
    const r = await call(magicLinkRoute, { method: 'POST', crossSite: true, body: { email: 'owner@example.com' }, headers: { 'sec-fetch-site': 'same-origin' } });
    expect(r.status).toBe(200);
  });

  it('share POST from another site is refused', async () => {
    const { token } = await makeLink(['VOTE']);
    expect((await hitShare(voteRoute, token, { method: 'POST', origin: 'https://evil.test' })).status).toBe(403);
    expect((await hitShare(voteRoute, token, { method: 'POST', origin: null })).status).toBe(403);
  });

  it('GETs are not affected', async () => {
    clearPrincipalCache();
    expect((await call(meRoute, { cookie: adminCookie, headers: { origin: 'https://evil.test' } })).status).toBe(200);
  });
});

