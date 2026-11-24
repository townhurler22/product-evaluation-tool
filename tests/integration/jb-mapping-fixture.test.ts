// P5 acceptance on the §13.4 fixture (PGlite): PT-14 and PT-18 statement counts do not change with the number of
// cards or boards (D-18, D-26, PERF-B16, PERF-B19, PT-16), and overlay and panel counts agree (D-29).
// Scaled down as the other fixture tests are: the property under test is "count independent of size".
import { describe, expect, it } from 'vitest';
import { freshDb } from '../db';
import { call, signInAll } from '../fh';
import { breakdown, ideas, overlay, panel, sync } from '../mapping';
import { seedFeedbackHubFixture, seedFixture, seedMappingFixture } from '../../db/seed';
import { clearPrincipalCache } from '@/modules/core/auth/principal';
import { GET as featureCards } from '@/app/api/fh/features/[id]/cards/route';
import { STATEMENT_BUDGETS } from '@/server/http/budgets';

const DEMAND_BOARD = '0190c3a3-0000-7000-8000-000000000002';
const JOURNEY_1 = '0190c3a4-0000-7000-8000-000000000001';
const OWNER = `'0190c3a2-0000-7000-8000-000000000001'::uuid`;

async function fixture(scale: number) {
  const ctx = await freshDb();
  await seedFixture(ctx.pg, scale);
  await seedFeedbackHubFixture(ctx.pg, scale);
  const shape = await seedMappingFixture(ctx.pg, scale);
  const cookies = await signInAll(ctx.pg);
  return { ...ctx, ...cookies, shape };
}

/** Each call on a principal-cache miss, so every count includes the preamble. */
async function measure(fn: () => Promise<{ status: number; statements: number }>) {
  clearPrincipalCache();
  const r = await fn();
  expect(r.status).toBe(200);
  return r.statements;
}

describe('PT-14 demand overlay on the fixture (PERF-B16, D-18, D-19)', () => {
  it('statement counts are the same on the base and a 10× fixture, within budget, and overlay and panel agree (D-29)', async () => {
    async function run(scale: number) {
      const f = await fixture(scale);
      const out: Record<string, number> = {};
      out.overlayTop = await measure(() => overlay(f.admin, DEMAND_BOARD));
      out.overlayTopAll = await measure(() => overlay(f.admin, DEMAND_BOARD, 'all'));
      out.overlayJourney = await measure(() => overlay(f.admin, JOURNEY_1));
      out.panelTop = await measure(() => panel(f.admin, DEMAND_BOARD, 'p1'));
      out.panelJourney = await measure(() => panel(f.admin, JOURNEY_1, 'q1'));
      out.ideas = await measure(() => ideas(f.admin, DEMAND_BOARD, 'p1'));
      out.breakdown = await measure(() => breakdown(f.admin, DEMAND_BOARD, 'p1'));
      const anyFeature = (await f.pg.query<{ to_id: string }>(`SELECT to_id FROM core_link WHERE relation = 'maps-to-feature' LIMIT 1`)).rows[0].to_id;
      out.mapped = await measure(() => call(featureCards, { cookie: f.admin, params: { id: anyFeature } }));

      // D-29: every card's overlay count and release date equal its panel's, on both levels.
      for (const scope of ['open', 'all']) {
        const top = (await overlay(f.admin, DEMAND_BOARD, scope)).body;
        expect(Object.keys(top.counts)).toHaveLength(f.shape.products); // every top-level card's journey links Features
        for (let k = 1; k <= f.shape.products; k++) {
          const p = (await panel(f.admin, DEMAND_BOARD, `p${k}`, scope)).body;
          expect(p.total, `p${k} ${scope}`).toBe(top.counts[`p${k}`]);
          expect(p.targetDate).toBe(top.releaseDates[`p${k}`]);
        }
        const jo = (await overlay(f.admin, JOURNEY_1, scope)).body;
        for (const q of ['q1', 'q2', 'q3']) expect((await panel(f.admin, JOURNEY_1, q, scope)).body.total).toBe(jo.counts[q]);
      }
      await f.pg.close();
      return out;
    }
    const small = await run(0.01);
    const large = await run(0.1);
    expect(large).toEqual(small);
    expect(small.overlayTop).toBeLessThanOrEqual(4); // PERF-30
    expect(small.overlayTop).toBeLessThanOrEqual(STATEMENT_BUDGETS['GET /api/jb/boards/:id/overlay']);
  }, 240_000);
});

describe('PT-18 Journey sync with 10 and with 100 boards in the workspace (PERF-B19, D-26)', () => {
  it('the statement count does not depend on the number of boards or of cards sharing the Journey', async () => {
    async function run(boards: number) {
      const f = await fixture(0.01);
      const extra = boards - 2; // the base fixture at this scale has 2 top-level boards
      const id = (p: string, e: string) => `('${p}-0000-7000-8000-' || lpad(to_hex(${e}), 12, '0'))`;
      // Extra boards whose Product cards share the title and the Journey of the card we sync, each with a mapped journey.
      await f.pg.exec(`
        INSERT INTO jb_board (id, name, owner_id) SELECT ${id('0190c3af', 'g')}, 'Extra ' || g, ${OWNER} FROM generate_series(1, ${extra}) g;
        INSERT INTO jb_board (id, name, owner_id, journey_of_board_id, journey_of_node_id)
          SELECT ${id('0190c3b0', 'g')}, 'Extra journey ' || g, ${OWNER}, ${id('0190c3af', 'g')}, 'p1' FROM generate_series(1, ${extra}) g;
        INSERT INTO jb_node (board_id, id, kind, x, y, sort_key, data, last_seq)
          SELECT ${id('0190c3af', 'g')}, 'p1', 'product-card', 0, 0, 'V', '{"title":"Product 1"}', 0 FROM generate_series(1, ${extra}) g;
        INSERT INTO jb_node (board_id, id, kind, x, y, sort_key, data, last_seq)
          SELECT ${id('0190c3b0', 'g')}, 'q1', 'product-card', 0, 0, 'V', '{"title":"Step"}', 0 FROM generate_series(1, ${extra}) g;
        INSERT INTO core_link (id, relation, from_module, from_kind, from_id, from_scope_id, to_module, to_kind, to_id)
          SELECT gen_random_uuid(), 'maps-to-feature', 'jb', 'card', ${id('0190c3b0', 'g')} || ':q1', ${id('0190c3b0', 'g')}, 'fh', 'feature',
                 ${id('0190c3a4', '1 + g % 20')} FROM generate_series(1, ${extra}) g;
        INSERT INTO core_link (id, relation, from_module, from_kind, from_id, from_scope_id, to_module, to_kind, to_id)
          SELECT gen_random_uuid(), 'maps-to-journey', 'jb', 'card', ${id('0190c3af', 'g')} || ':p1', ${id('0190c3af', 'g')}, 'fh', 'journey',
                 ${id('0190c3a7', '1')} FROM generate_series(1, ${extra}) g;`);
      expect((await f.pg.query(`SELECT count(*)::int n FROM jb_board WHERE journey_of_board_id IS NULL`)).rows[0]).toEqual({ n: boards });
      const first = await measure(() => sync(f.admin, DEMAND_BOARD, 'p1'));   // shared Journey: create "Product 1", re-assign the one left behind
      const again = await measure(() => sync(f.admin, DEMAND_BOARD, 'p1'));   // found, steady state
      const r = await sync(f.admin, DEMAND_BOARD, 'p1');
      await f.pg.close();
      return { first, again, shared: r.body.sharedBy.cards.length + r.body.sharedBy.hidden };
    }
    const ten = await run(10);
    const hundred = await run(100);
    expect(hundred.first).toBe(ten.first);
    expect(hundred.again).toBe(ten.again);
    expect(ten.shared).toBe(1);
    expect(ten.first).toBeLessThanOrEqual(STATEMENT_BUDGETS['POST /api/jb/boards/:id/nodes/:nodeId/journey-sync']);
  }, 240_000);
});
