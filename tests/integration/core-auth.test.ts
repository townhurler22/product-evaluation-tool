import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshDb } from '../db';
import { call, cookieFrom } from '../http';
import { GET as me } from '@/app/api/me/route';
import { POST as magicLink } from '@/app/api/auth/magic-link/route';
import { GET as callback } from '@/app/api/auth/callback/route';
import { POST as demo } from '@/app/api/auth/demo/route';
import { POST as signOutRoute } from '@/app/api/auth/sign-out/route';
import { GET as healthz } from '@/app/api/healthz/route';
import { GET as readyz } from '@/app/api/readyz/route';
import { requestMagicLink, DEMO_EMAIL } from '@/modules/core/auth/sign-in';
import { clearPrincipalCache } from '@/modules/core/auth/principal';
import { newId } from '@/modules/core/util';

let ctx: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => {
  ctx = await freshDb();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  delete process.env.DEMO_MODE;
});

async function signInAs(email: string): Promise<string> {
  const link = await requestMagicLink({ email, ipHash: null, origin: 'http://localhost:3000' });
  const token = new URL(link!).searchParams.get('token')!;
  const res = await call(callback, { path: `/api/auth/callback?token=${encodeURIComponent(token)}` });
  expect(res.status).toBe(303);
  return cookieFrom(res.setCookie);
}

describe('migrations', () => {
  it('apply from empty', () => expect(ctx.applied).toEqual(['0001_core']));

  it('audit log is append-only', async () => {
    await ctx.pg.query(`INSERT INTO core_audit_log (id, actor_kind, action) VALUES ($1, 'system', 'test')`, [newId()]);
    await expect(ctx.pg.query(`UPDATE core_audit_log SET action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(ctx.pg.query(`DELETE FROM core_audit_log`)).rejects.toThrow(/append-only/);
  });
});

describe('health (NFR-27)', () => {
  it('healthz touches no database', async () => {
    const r = await call(healthz);
    expect(r.status).toBe(200);
    expect(r.statements).toBe(0);
  });
  it('readyz checks the schema in one statement', async () => {
    const r = await call(readyz);
    expect(r.body).toEqual({ ok: true, schema: '0001_core' });
    expect(r.statements).toBe(1);
  });
});

describe('magic-link sign-in (OD-01)', () => {
  it('owner signs in, becomes ADMIN, and /api/me works', async () => {
    const cookie = await signInAs('Owner@Example.com');
    const r = await call(me, { cookie });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ role: 'ADMIN', isWorkspaceAdmin: true, isFeedbackAdmin: true });
  });

  it('answers the same for unknown emails and sends nothing', async () => {
    const r = await call(magicLink, { method: 'POST', body: { email: 'stranger@nowhere.test' } });
    expect(r.status).toBe(200);
    const { rows } = await ctx.pg.query('SELECT count(*)::int AS n FROM core_magic_link');
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('allowed domains can sign in as MEMBER', async () => {
    await ctx.pg.query(`UPDATE core_setting SET value = '["team.test"]' WHERE key = 'auth.allowed_domains'`);
    const cookie = await signInAs('new.person@team.test');
    expect((await call(me, { cookie })).body).toMatchObject({ role: 'MEMBER' });
  });

  it('a link works once (410 on reuse)', async () => {
    const link = await requestMagicLink({ email: 'owner@example.com', ipHash: null, origin: 'http://x' });
    const path = `/api/auth/callback?token=${encodeURIComponent(new URL(link!).searchParams.get('token')!)}`;
    expect((await call(callback, { path })).status).toBe(303);
    const again = await call(callback, { path });
    expect(again.status).toBe(410);
    expect(again.body).toMatchObject({ code: 'gone' });
  });

  it('rejects a bad email with the field name (400)', async () => {
    const r = await call(magicLink, { method: 'POST', body: { email: 'not-an-email' } });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'validation', details: { field: 'email' } });
  });

  it('rate limits per email (429)', async () => {
    for (let i = 0; i < 5; i++) await call(magicLink, { method: 'POST', body: { email: 'owner@example.com' } });
    const r = await call(magicLink, { method: 'POST', body: { email: 'owner@example.com' } });
    expect(r.status).toBe(429);
  });
});

describe('preamble (ARC-07, PT-06 statement count)', () => {
  it('costs 1 statement on a principal-cache miss and 0 on a hit', async () => {
    const cookie = await signInAs('owner@example.com');
    clearPrincipalCache();
    expect((await call(me, { cookie })).statements).toBe(1);
    expect((await call(me, { cookie })).statements).toBe(0);
  });

  it('401 without a session', async () => {
    const r = await call(me);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ code: 'unauthenticated' });
  });

  it('bumping session_epoch revokes existing sessions (ARC-11)', async () => {
    const cookie = await signInAs('owner@example.com');
    await ctx.pg.query(`UPDATE core_user SET session_epoch = session_epoch + 1`);
    clearPrincipalCache();
    expect((await call(me, { cookie })).status).toBe(401);
  });

  it('a disabled user is refused (ARC-12)', async () => {
    const cookie = await signInAs('owner@example.com');
    await ctx.pg.query(`UPDATE core_user SET status = 'DISABLED'`);
    clearPrincipalCache();
    expect((await call(me, { cookie })).status).toBe(401);
  });
});

describe('demo sign-in (OD-01, OD-02)', () => {
  it('404 unless this is the demo deployment', async () => {
    expect((await call(demo, { method: 'POST' })).status).toBe(404);
  });

  it('signs in as the seeded demo user', async () => {
    process.env.DEMO_MODE = '1';
    await ctx.pg.query(`INSERT INTO core_user (id, email, role, status) VALUES ($1, $2, 'PRODUCT', 'ACTIVE')`, [newId(), DEMO_EMAIL]);
    const r = await call(demo, { method: 'POST' });
    expect(r.status).toBe(200);
    expect((await call(me, { cookie: cookieFrom(r.setCookie) })).body).toMatchObject({ role: 'PRODUCT' });
  });

  it('sign-out revokes the session row and clears the cookie', async () => {
    const cookie = await signInAs('owner@example.com');
    const r = await call(signOutRoute, { method: 'POST', cookie });
    expect(r.setCookie).toMatch(/pet_session=;/);
    const { rows } = await ctx.pg.query<{ n: number }>('SELECT count(*)::int AS n FROM core_session WHERE revoked_at IS NOT NULL');
    expect(rows[0].n).toBe(1);
  });
});
