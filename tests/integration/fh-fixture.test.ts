// §13.4 Feedback Hub fixture: reconciliation finds zero drift (P1 acceptance), repairs injected drift (INV-18),
// and PT-16: every Feedback Hub endpoint keeps the same statement count on the base and a 10× fixture.
import { describe, expect, it } from 'vitest';
import { freshDb } from '../db';
import { call, signInAll, specQ } from '../fh';
import { seedFeedbackHubFixture, seedFixture } from '../../db/seed';
import { reconcile } from '@/modules/fh/jobs';
import { clearPrincipalCache } from '@/modules/core/auth/principal';
import { GET as lookupsRoute } from '@/app/api/fh/lookups/route';
import { GET as listRoute, POST as createRoute } from '@/app/api/fh/ideas/route';
import { GET as facetsRoute } from '@/app/api/fh/ideas/facets/route';
import { POST as idsRoute } from '@/app/api/fh/ideas/ids/route';
import { POST as exportRoute } from '@/app/api/fh/ideas/export/route';
import { GET as summaryRoute, PATCH as patchRoute } from '@/app/api/fh/ideas/[id]/route';
import { GET as evidenceRoute } from '@/app/api/fh/ideas/[id]/evidence/route';
import { GET as activityRoute } from '@/app/api/fh/ideas/[id]/activity/route';
import { GET as matchesRoute } from '@/app/api/fh/ideas/[id]/matches/route';
import { PUT as statusRoute } from '@/app/api/fh/ideas/[id]/status/route';
import { POST as mergeRoute } from '@/app/api/fh/ideas/[id]/merge/route';
import { GET as roadmapRoute } from '@/app/api/fh/roadmap/route';
import { GET as boardRoute } from '@/app/api/fh/board/route';
import { GET as companiesRoute } from '@/app/api/fh/companies/route';
import type { IdeaRow } from '@/modules/fh/rows';

const IDEA = (g: number) => `0190c3a5-0000-7000-8000-${g.toString(16).padStart(12, '0')}`;

async function fixture(scale: number) {
  const ctx = await freshDb();
  await seedFixture(ctx.pg, scale);
  await seedFeedbackHubFixture(ctx.pg, scale);
  const cookies = await signInAll(ctx.pg);
  return { ...ctx, ...cookies };
}

describe('fixture and reconciliation (§4.11, INV-18)', () => {
  it('builds the fixture shape and reconciliation finds zero drift', async () => {
    const { pg } = await fixture(0.01);
    const { rows } = await pg.query<Record<string, number>>(`SELECT
      (SELECT count(*)::int FROM fh_idea) ideas, (SELECT count(*)::int FROM fh_idea WHERE idea_type = 'BUG') bugs,
      (SELECT count(*)::int FROM fh_idea WHERE merged_into_id IS NOT NULL) merged,
      (SELECT count(*)::int FROM fh_feature) features, (SELECT max(depth)::int FROM fh_feature) depth`);
    expect(rows[0]).toEqual({ ideas: 500, bugs: 50, merged: 25, features: 6, depth: 2 });
    expect(await reconcile(undefined, false)).toEqual({ rollupDrift: 0, demandDrift: 0, closureDrift: 0 });
  });

  it('detects and repairs drift in roll-ups, demand counts and the closure table', async () => {
    const { pg } = await fixture(0.01);
    await pg.exec(`
      UPDATE fh_idea_rollup SET arr = arr + 1 WHERE idea_id = '${IDEA(1)}';
      UPDATE fh_feature_demand SET all_count = all_count + 3 WHERE feature_id = (SELECT feature_id FROM fh_idea WHERE id = '${IDEA(2)}');
      DELETE FROM fh_feature_closure WHERE distance = 2 AND ctid IN (SELECT ctid FROM fh_feature_closure WHERE distance = 2 LIMIT 1);`);
    const found = await reconcile();
    expect(found.rollupDrift).toBe(1);
    expect(found.demandDrift).toBe(1);
    expect(found.closureDrift).toBe(1);
    expect(await reconcile(undefined, false)).toEqual({ rollupDrift: 0, demandDrift: 0, closureDrift: 0 });
  });

  it('stays drift-free after a sequence of writes through the API', async () => {
    const { admin } = await fixture(0.01);
    const created = (await call<{ row: IdeaRow }>(createRoute, { method: 'POST', cookie: admin, body: { title: 'Fresh', featureId: '0190c3a4-0000-7000-8000-000000000001' } })).body.row;
    await call(statusRoute, { method: 'PUT', cookie: admin, params: { id: IDEA(3) }, body: { status: 'IDEA_CLOSED' } });
    await call(mergeRoute, { method: 'POST', cookie: admin, params: { id: IDEA(5) }, body: { targetId: created.id } });
    await call(patchRoute, { method: 'PATCH', cookie: admin, params: { id: IDEA(6) }, body: { featureId: null } });
    expect(await reconcile(undefined, false)).toEqual({ rollupDrift: 0, demandDrift: 0, closureDrift: 0 });
  });

  it('D-07: the list reads derived sources from the roll-up, not from insight rows', async () => {
    const { pg, member } = await fixture(0.01);
    await pg.query(`UPDATE fh_idea_rollup SET sources = '{CRM}' WHERE idea_id = $1`, [IDEA(1)]);
    const r = await call<{ rows: IdeaRow[] }>(listRoute, { cookie: member, path: `/api/fh/ideas?${specQ({ sort: { column: 'number', dir: 'asc' } })}` });
    expect(r.body.rows[0].sources).toEqual(['CRM']);
  });
});

describe('PT-16: statement counts do not grow with data', () => {
  async function counts(scale: number) {
    const f = await fixture(scale);
    const out: Record<string, number> = {};
    const sizes: Record<string, number> = {};
    const run = async (name: string, h: Parameters<typeof call>[0], opts: Parameters<typeof call>[1]) => {
      clearPrincipalCache(); // measure the worst case: a principal-cache miss
      const r = await call(h, { cookie: f.admin, ...opts });
      expect(r.status, name).toBeLessThan(300);
      out[name] = r.statements;
      sizes[name] = JSON.stringify(r.body).length;
    };
    for (const view of ['all', 'triage', 'backlog', 'roadmap', 'board'] as const) {
      await run(`list ${view}`, listRoute, { path: `/api/fh/ideas?${specQ({ view })}` });
      await run(`list ${view} filtered`, listRoute, { path: `/api/fh/ideas?${specQ({ view, search: 'export', filters: { source: ['CALL'], type: ['FEATURE_REQUEST', 'BUG'] }, sort: { column: 'arr', dir: 'desc' } })}` });
    }
    await run('lookups', lookupsRoute, { path: '/api/fh/lookups' });
    for (const col of ['status', 'owner', 'companies', 'themes', 'source', 'triage']) await run(`facets ${col}`, facetsRoute, { path: `/api/fh/ideas/facets?${specQ()}&column=${col}` });
    await run('ids', idsRoute, { method: 'POST', body: { viewSpec: { view: 'triage' } } });
    await run('summary', summaryRoute, { params: { id: IDEA(1) } });
    await run('evidence', evidenceRoute, { params: { id: IDEA(1) } });
    await run('activity', activityRoute, { params: { id: IDEA(1) } });
    await run('matches', matchesRoute, { params: { id: IDEA(1) } });
    await run('roadmap', roadmapRoute, { path: `/api/fh/roadmap?${specQ()}&from=2026-01-01&to=2026-06-30` });
    await run('board', boardRoute, { path: `/api/fh/board?${specQ()}&group=status` });
    await run('companies', companiesRoute, { path: '/api/fh/companies?q=company' });
    await run('create', createRoute, { method: 'POST', body: { title: 'Measured create' } });
    await run('patch', patchRoute, { method: 'PATCH', params: { id: IDEA(7) }, body: { title: 'Measured edit' } });
    await run('status', statusRoute, { method: 'PUT', params: { id: IDEA(9) }, body: { status: 'IDEA_CLOSED' } });
    clearPrincipalCache();
    const exp = await call(exportRoute, { method: 'POST', cookie: f.admin, body: { viewSpec: { view: 'all' }, columns: ['number', 'title', 'arr'] } });
    out.export = exp.statements;
    return { out, sizes };
  }

  it('is identical on the base and a 10× fixture, and payloads stay within budget (PERF-B04, PERF-B05)', async () => {
    // Scaled down 100× to keep CI fast; the property under test is "count independent of size".
    const small = await counts(0.01);
    const large = await counts(0.1);
    expect(large.out).toEqual(small.out);
    for (const [name, size] of Object.entries(large.sizes)) {
      if (name.startsWith('list')) expect(size, name).toBeLessThanOrEqual(100 * 1024); // ≤ 100 KB per 100 rows
    }
    expect(large.sizes.summary).toBeLessThanOrEqual(50 * 1024);
    expect(large.out['list all']).toBeLessThanOrEqual(4);
    expect(large.out.summary).toBeLessThanOrEqual(3);
    expect(large.out.create).toBeLessThanOrEqual(6);
  }, 600_000);
});
