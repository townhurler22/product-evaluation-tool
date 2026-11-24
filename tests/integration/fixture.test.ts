// NFR-18 deterministic fixture; PT-16 shape: Core endpoints keep the same statement count on 1× and 10× data.
import { describe, expect, it } from 'vitest';
import { freshDb } from '../db';
import { call, cookieFrom } from '../http';
import { seedDemo, seedFixture } from '../../db/seed';
import { requestMagicLink } from '@/modules/core/auth/sign-in';
import { GET as callback } from '@/app/api/auth/callback/route';
import { GET as usersRoute } from '@/app/api/core/admin/users/route';
import { GET as auditRoute } from '@/app/api/core/admin/audit/route';
import { GET as clientsRoute } from '@/app/api/core/admin/intake/clients/route';
import { GET as meRoute } from '@/app/api/me/route';
import { clearPrincipalCache } from '@/modules/core/auth/principal';
import { GET as boardsRoute } from '@/app/api/jb/boards/route';
import { GET as contentRoute } from '@/app/api/jb/boards/[id]/content/route';
import { POST as opsRoute } from '@/app/api/jb/boards/[id]/ops/route';

async function statementsOn(scale: number) {
  const ctx = await freshDb();
  await seedFixture(ctx.pg, scale);
  const link = await requestMagicLink({ email: 'owner@example.com', ipHash: null, origin: 'http://x' });
  const cookie = cookieFrom((await call(callback, { path: `/api/auth/callback?token=${encodeURIComponent(new URL(link!).searchParams.get('token')!)}` })).setCookie);
  const counts: Record<string, number> = {};
  for (const [name, h] of [['me', meRoute], ['users', usersRoute], ['audit', auditRoute], ['intake', clientsRoute]] as const) {
    clearPrincipalCache();
    counts[name] = (await call(h, { cookie })).statements;
  }
  return { ctx, counts };
}

describe('fixture (§13.4)', () => {
  it('is deterministic', async () => {
    const a = await freshDb(); await seedFixture(a.pg, 0.01);
    const b = await freshDb(); await seedFixture(b.pg, 0.01);
    const q = 'SELECT id, name, domain, arr::text FROM core_company ORDER BY id';
    expect((await a.pg.query(q)).rows).toEqual((await b.pg.query(q)).rows);
  });

  it('demo seed is idempotent and creates the sandbox user', async () => {
    const { pg } = await freshDb();
    await seedDemo(pg); await seedDemo(pg);
    const { rows } = await pg.query(`SELECT role, status FROM core_user WHERE email = 'demo@example.com'`);
    expect(rows).toEqual([{ role: 'PRODUCT', status: 'ACTIVE' }]);
  });

  it('PT-16: statement counts do not change between the base and a 10× fixture', async () => {
    // Scaled down 100× to keep CI fast; the property under test is "count independent of size".
    const small = await statementsOn(0.01);
    const large = await statementsOn(0.1);
    expect(large.counts).toEqual(small.counts);
  }, 120_000);

  it('PT-16: Journey Boards endpoints keep the same statement count on the base and a 10× fixture', async () => {
    async function jb(scale: number) {
      const { counts } = await statementsOn(scale); void counts;
      const link = await requestMagicLink({ email: 'owner@example.com', ipHash: null, origin: 'http://x' });
      const cookie = cookieFrom((await call(callback, { path: `/api/auth/callback?token=${encodeURIComponent(new URL(link!).searchParams.get('token')!)}` })).setCookie);
      const large = '0190c3a3-0000-7000-8000-000000000001';
      const out: Record<string, number> = {};
      clearPrincipalCache(); out.boards = (await call(boardsRoute, { cookie })).statements;
      clearPrincipalCache(); out.content = (await call(contentRoute, { cookie, params: { id: large } })).statements;
      clearPrincipalCache();
      const ops = Array.from({ length: 50 }, (_, k) => ({ type: 'node', op: 'patch', id: `n${(k % 20) + 1}`, baseVersion: 1, set: { x: k } })); // 50 ops over 20 cards (the smallest fixture)
      const r = await call(opsRoute, { method: 'POST', cookie, params: { id: large }, body: { batchId: `fixture-${Math.round(scale * 1000)}`, clientId: 'fixture', protocol: 1, ops } });
      expect(r.status).toBe(200);
      out.ops = r.statements;
      return out;
    }
    expect(await jb(0.1)).toEqual(await jb(0.01)); // scaled down as above; the largest board still grows 10×
  }, 240_000);
});
