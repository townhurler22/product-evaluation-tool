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
});
