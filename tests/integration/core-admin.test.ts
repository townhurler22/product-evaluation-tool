// ARC-16 admin console; NFR-16 authorisation matrix for every admin route; §11.1 route tables.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from '../db';
import { call, cookieFrom } from '../http';
import { requestMagicLink } from '@/modules/core/auth/sign-in';
import { GET as callback } from '@/app/api/auth/callback/route';
import { GET as meRoute } from '@/app/api/me/route';
import { GET as usersRoute } from '@/app/api/core/admin/users/route';
import { PATCH as userPatch } from '@/app/api/core/admin/users/[id]/route';
import { GET as settingsGet, PUT as settingsPut } from '@/app/api/core/admin/settings/route';
import { GET as auditRoute } from '@/app/api/core/admin/audit/route';
import { GET as jobsRoute } from '@/app/api/core/admin/jobs/route';
import { POST as retryRoute } from '@/app/api/core/admin/jobs/[id]/retry/route';
import { GET as clientsGet, POST as clientsPost } from '@/app/api/core/admin/intake/clients/route';
import { PATCH as clientPatch } from '@/app/api/core/admin/intake/clients/[id]/route';
import { POST as keysPost } from '@/app/api/core/admin/intake/clients/[id]/keys/route';
import { POST as keyRevoke } from '@/app/api/core/admin/intake/clients/[id]/keys/[keyId]/revoke/route';
import { GET as clientLogRoute } from '@/app/api/core/admin/intake/clients/[id]/log/route';
import { POST as reviewsPost } from '@/app/api/core/admin/intake/reviews/route';
import { PUT as pausePut } from '@/app/api/core/admin/intake/pause/route';
import { clearPrincipalCache } from '@/modules/core/auth/principal';

process.env.INGEST_MASTER_KEY = 'test-master-key-0123456789abcdef0123';
process.env.INGEST_ENVIRONMENT = 'staging';

let ctx: Awaited<ReturnType<typeof freshDb>>;
let admin: string;
let member: string;

async function signIn(email: string) {
  const link = await requestMagicLink({ email, ipHash: null, origin: 'http://x' });
  return cookieFrom((await call(callback, { path: `/api/auth/callback?token=${encodeURIComponent(new URL(link!).searchParams.get('token')!)}` })).setCookie);
}

beforeEach(async () => {
  ctx = await freshDb();
  await ctx.pg.query(`UPDATE core_setting SET value = '["team.test"]' WHERE key = 'auth.allowed_domains'`);
  admin = await signIn('owner@example.com');
  member = await signIn('member@team.test');
});

const ID = '0190c3a0-0000-7000-8000-000000000123';

// Every admin route with a minimal valid request. A new admin route must be added here (checked below).
interface MatrixRoute {
  name: string;
  h: Parameters<typeof call>[0];
  method: string;
  body?: unknown;
  params?: Record<string, string>;
}
const ADMIN_ROUTES: MatrixRoute[] = [
  { name: 'GET users', h: usersRoute, method: 'GET' },
  { name: 'PATCH users/:id', h: userPatch, method: 'PATCH', body: { role: 'PRODUCT' }, params: { id: ID } },
  { name: 'GET settings', h: settingsGet, method: 'GET' },
  { name: 'PUT settings', h: settingsPut, method: 'PUT', body: { currency: 'EUR' } },
  { name: 'GET audit', h: auditRoute, method: 'GET' },
  { name: 'GET jobs', h: jobsRoute, method: 'GET' },
  { name: 'POST jobs/:id/retry', h: retryRoute, method: 'POST', params: { id: ID } },
  { name: 'GET intake/clients', h: clientsGet, method: 'GET' },
  { name: 'POST intake/clients', h: clientsPost, method: 'POST', body: { name: 'X', environment: 'staging', routes: ['call-requests'] } },
  { name: 'PATCH intake/clients/:id', h: clientPatch, method: 'PATCH', body: { ratePerMinute: 5 }, params: { id: ID } },
  { name: 'POST intake/clients/:id/keys', h: keysPost, method: 'POST', params: { id: ID } },
  { name: 'POST intake/…/keys/:keyId/revoke', h: keyRevoke, method: 'POST', params: { id: ID, keyId: 'ik_x' } },
  { name: 'GET intake/clients/:id/log', h: clientLogRoute, method: 'GET', params: { id: ID } },
  { name: 'POST intake/reviews', h: reviewsPost, method: 'POST', body: { kind: 'gateway', notes: 'Reviewed the gateway.' } },
  { name: 'PUT intake/pause', h: pausePut, method: 'PUT', body: { module: 'fh', paused: false } },
];

describe('authorisation matrix (NFR-16)', () => {
  it('covers every admin route file', () => {
    const root = join(process.cwd(), 'src', 'app', 'api', 'core', 'admin');
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : f === 'route.ts' ? [p] : [];
    });
    const exported = walk(root).flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => `${m[1]} ${relative(root, f).split(sep).join('/')}`));
    expect(exported.length).toBe(ADMIN_ROUTES.length);
  });

  for (const r of ADMIN_ROUTES) {
    it(`${r.name}: anonymous 401, member 403, admin not 401/403`, async () => {
      const opts = { method: r.method, body: r.body, params: r.params };
      expect((await call(r.h, opts)).status).toBe(401);
      expect((await call(r.h, { ...opts, cookie: member })).status).toBe(403);
      expect([401, 403]).not.toContain((await call(r.h, { ...opts, cookie: admin })).status);
    });
  }
});

describe('route tables do not overlap (§11.1)', () => {
  it('every API route lives in exactly one table', () => {
    const root = join(process.cwd(), 'src', 'app', 'api');
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : f === 'route.ts' ? [relative(root, d).split(sep).join('/')] : [];
    });
    const table = (p: string) =>
      /^(core|fh|jb)(\/|$)/.test(p) ? 'staff' : p.startsWith('share/') ? 'share' : p.startsWith('ingest/') ? 'intake'
        : p.startsWith('auth/') ? 'auth' : ['healthz', 'readyz', 'me', 'internal/jobs/drain'].includes(p) ? 'system' : 'unknown';
    const unknown = walk(root).filter((p) => table(p) === 'unknown');
    expect(unknown).toEqual([]);
  });
});

describe('users', () => {
  const memberId = async () => (await ctx.pg.query<{ id: string }>(`SELECT id FROM core_user WHERE email = 'member@team.test'`)).rows[0].id;

  it('lists users with keyset pagination', async () => {
    const r = await call(usersRoute, { cookie: admin });
    expect(r.body.users.map((u: { email: string }) => u.email)).toEqual(['member@team.test', 'owner@example.com']);
    expect(r.body.nextCursor).toBeNull();
  });

  it('deactivating ends sessions at once on this instance (SEC-05, ARC-12) and is audited', async () => {
    const id = await memberId();
    expect((await call(meRoute, { cookie: member })).status).toBe(200);
    const r = await call(userPatch, { method: 'PATCH', cookie: admin, params: { id }, body: { status: 'DISABLED' } });
    expect(r.body.user.status).toBe('DISABLED');
    expect((await call(meRoute, { cookie: member })).status).toBe(401);
    const { rows } = await ctx.pg.query(`SELECT action FROM core_audit_log WHERE target_id = $1`, [id]);
    expect(rows).toEqual([{ action: 'core.user.status_change' }]);
  });

  it('keeps at least one admin, and admins cannot demote themselves', async () => {
    const ownerId = (await ctx.pg.query<{ id: string }>(`SELECT id FROM core_user WHERE email = 'owner@example.com'`)).rows[0].id;
    const r = await call(userPatch, { method: 'PATCH', cookie: admin, params: { id: ownerId }, body: { role: 'MEMBER' } });
    expect(r.status).toBe(422);
  });

  it('role changes apply to the changed user (principal cache)', async () => {
    const id = await memberId();
    await call(userPatch, { method: 'PATCH', cookie: admin, params: { id }, body: { role: 'PRODUCT' } });
    clearPrincipalCache();
    expect((await call(meRoute, { cookie: member })).body).toMatchObject({ role: 'PRODUCT', isFeedbackAdmin: true });
  });
});

describe('settings', () => {
  it('validates and saves, normalising domains', async () => {
    const r = await call(settingsPut, { method: 'PUT', cookie: admin, body: { 'intake.staff_domains': ['Vendor.TEST'], 'release_train.length_days': 14 } });
    expect(r.status).toBe(200);
    expect(r.body.settings['intake.staff_domains']).toEqual(['vendor.test']);
    expect(r.body.settings['release_train.anchor']).toBe('2026-01-05');
  });

  it('rejects unknown keys and bad values with the field name', async () => {
    expect((await call(settingsPut, { method: 'PUT', cookie: admin, body: { hack: 1 } })).status).toBe(400);
    const bad = await call(settingsPut, { method: 'PUT', cookie: admin, body: { currency: 'euro' } });
    expect(bad.body).toMatchObject({ code: 'validation', details: { field: 'currency' } });
  });
});

describe('intake console (ING-28 to ING-38)', () => {
  it('create a client, issue a key once, see it in the overview without the secret, revoke it', async () => {
    const c = await call(clientsPost, { method: 'POST', cookie: admin, body: { name: 'Transcript agent', environment: 'staging', routes: ['call-requests'] } });
    expect(c.status).toBe(201);
    const k = await call(keysPost, { method: 'POST', cookie: admin, params: { id: c.body.client.id } });
    expect(k.status).toBe(201);
    expect(k.body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(k.headers.get('cache-control')).toBe('no-store');
    const o = await call(clientsGet, { cookie: admin });
    expect(o.body.clients[0].keys[0]).toMatchObject({ id: k.body.keyId, status: 'active' });
    expect(JSON.stringify(o.body)).not.toContain(k.body.secret);
    await call(keyRevoke, { method: 'POST', cookie: admin, params: { id: c.body.client.id, keyId: k.body.keyId } });
    expect((await call(clientsGet, { cookie: admin })).body.clients[0].keys[0].status).toBe('revoked');
  });

  it('duplicate client name is 409', async () => {
    const body = { name: 'Dup', environment: 'staging', routes: ['call-requests'] };
    await call(clientsPost, { method: 'POST', cookie: admin, body });
    expect((await call(clientsPost, { method: 'POST', cookie: admin, body })).status).toBe(409);
  });
});

describe('audit and jobs', () => {
  it('the audit log is readable by admins and filters by action prefix', async () => {
    const r = await call(auditRoute, { cookie: admin, path: '/api/core/admin/audit?action=core.auth' });
    expect(r.body.entries.length).toBeGreaterThanOrEqual(2);
    expect(r.body.entries.every((e: { action: string }) => e.action.startsWith('core.auth'))).toBe(true);
  });

  it('dead letters can be retried', async () => {
    await ctx.pg.query(`INSERT INTO core_job (id, kind, state, attempts) VALUES ($1, 'x', 'dead', 5)`, [ID]);
    expect((await call(jobsRoute, { cookie: admin })).body.dead).toHaveLength(1);
    expect((await call(retryRoute, { method: 'POST', cookie: admin, params: { id: ID } })).status).toBe(200);
    expect((await call(jobsRoute, { cookie: admin })).body.dead).toHaveLength(0);
  });
});
