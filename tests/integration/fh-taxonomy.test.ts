// Features, Journeys, themes, milestones, saved views, lookups, export, roadmap, board, grants and realtime.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from '../db';
import { call, signInAll, specQ } from '../fh';
import { GET as lookupsRoute } from '@/app/api/fh/lookups/route';
import { GET as featuresGet, POST as featuresPost } from '@/app/api/fh/features/route';
import { PATCH as featurePatch, DELETE as featureDelete } from '@/app/api/fh/features/[id]/route';
import { GET as journeysGet } from '@/app/api/fh/journeys/route';
import { DELETE as journeyDelete } from '@/app/api/fh/journeys/[id]/route';
import { GET as themesGet, POST as themesPost } from '@/app/api/fh/themes/route';
import { PATCH as themePatch, DELETE as themeDelete } from '@/app/api/fh/themes/[id]/route';
import { GET as milestonesGet, POST as milestonesPost } from '@/app/api/fh/milestones/route';
import { PATCH as milestonePatch, DELETE as milestoneDelete } from '@/app/api/fh/milestones/[id]/route';
import { POST as assignRoute } from '@/app/api/fh/milestones/assign/route';
import { GET as viewsGet, POST as viewsPost } from '@/app/api/fh/saved-views/route';
import { PATCH as viewPatch, DELETE as viewDelete } from '@/app/api/fh/saved-views/[id]/route';
import { GET as companiesGet } from '@/app/api/fh/companies/route';
import { GET as peopleGet } from '@/app/api/fh/people/route';
import { GET as listRoute, POST as createRoute } from '@/app/api/fh/ideas/route';
import { POST as exportRoute } from '@/app/api/fh/ideas/export/route';
import { GET as roadmapRoute } from '@/app/api/fh/roadmap/route';
import { GET as boardRoute } from '@/app/api/fh/board/route';
import { PUT as statusRoute } from '@/app/api/fh/ideas/[id]/status/route';
import { PUT as datesRoute } from '@/app/api/fh/ideas/[id]/dates/route';
import { PUT as fhGrantPut } from '@/app/api/core/admin/users/[id]/fh-grant/route';
import { GET as meRoute } from '@/app/api/me/route';
import { POST as tokenRoute } from '@/app/api/core/realtime/token/route';
import type { IdeaRow } from '@/modules/fh/rows';

let ctx: Awaited<ReturnType<typeof freshDb>>;
let admin: string, member: string, pm: string;
const UX = '0190c3a0-0000-7000-8000-0000000000a1';
const MISSING = '0190c3a0-0000-7000-8000-00000000dead';

beforeEach(async () => {
  ctx = await freshDb();
  ({ admin, member, pm } = await signInAll(ctx.pg));
});

const feature = async (name: string, parentId: string | null = null) => {
  const r = await call<{ feature: { id: string; depth: number } }>(featuresPost, { method: 'POST', cookie: pm, body: { name, parentId } });
  expect(r.status, name).toBe(201);
  return r.body.feature;
};
const idea = async (title: string, extra: Record<string, unknown> = {}) =>
  (await call<{ row: IdeaRow }>(createRoute, { method: 'POST', cookie: admin, body: { title, ...extra } })).body.row;
const closure = async () => (await ctx.pg.query<{ a: string; d: string; n: number }>(
  `SELECT fa.name a, fd.name d, distance n FROM fh_feature_closure c JOIN fh_feature fa ON fa.id = c.ancestor_id JOIN fh_feature fd ON fd.id = c.descendant_id ORDER BY 1, 2`)).rows;

describe('Features (FH-601–604, INV-09)', () => {
  it('creates up to three levels, refuses deeper, unknown parents and duplicate siblings', async () => {
    const a = await feature('A'); const b = await feature('B', a.id); const c = await feature('C', b.id);
    expect(c.depth).toBe(2);
    expect((await call(featuresPost, { method: 'POST', cookie: pm, body: { name: 'D', parentId: c.id } })).status).toBe(422);
    expect((await call(featuresPost, { method: 'POST', cookie: pm, body: { name: 'X', parentId: MISSING } })).status).toBe(400);
    expect((await call(featuresPost, { method: 'POST', cookie: pm, body: { name: 'b ', parentId: a.id } })).status).toBe(409);
    expect((await call(featuresPost, { method: 'POST', cookie: member, body: { name: 'M' } })).status).toBe(403);
    expect(await closure()).toEqual([
      { a: 'A', d: 'A', n: 0 }, { a: 'A', d: 'B', n: 1 }, { a: 'A', d: 'C', n: 2 },
      { a: 'B', d: 'B', n: 0 }, { a: 'B', d: 'C', n: 1 }, { a: 'C', d: 'C', n: 0 },
    ]);
  });

  it('moves a subtree, rewriting depth and closure; refuses cycles and over-deep moves', async () => {
    const a = await feature('A'); const b = await feature('B', a.id); const c = await feature('C', b.id); const z = await feature('Z');
    expect((await call(featurePatch, { method: 'PATCH', cookie: pm, params: { id: a.id }, body: { parentId: c.id } })).status).toBe(422);
    expect((await call(featurePatch, { method: 'PATCH', cookie: pm, params: { id: b.id }, body: { parentId: z.id } })).status).toBe(200);
    expect((await call(featurePatch, { method: 'PATCH', cookie: pm, params: { id: z.id }, body: { parentId: a.id } })).status).toBe(422); // Z→B→C would be 4 levels
    const rows = await closure();
    expect(rows).toContainEqual({ a: 'Z', d: 'C', n: 2 });
    expect(rows).not.toContainEqual({ a: 'A', d: 'C', n: 2 });
    const depths = (await ctx.pg.query(`SELECT name, depth FROM fh_feature ORDER BY name`)).rows;
    expect(depths).toEqual([{ name: 'A', depth: 0 }, { name: 'B', depth: 1 }, { name: 'C', depth: 2 }, { name: 'Z', depth: 0 }]);
  });

  it('renames and reorders siblings', async () => {
    const a = await feature('A'); const b = await feature('B'); await feature('C');
    await call(featurePatch, { method: 'PATCH', cookie: pm, params: { id: b.id }, body: { position: 0, name: 'Bee' } });
    const r = await call<{ features: { name: string }[] }>(featuresGet, { cookie: member });
    expect(r.body.features.map((f) => f.name)).toEqual(['Bee', 'A', 'C']);
    void a;
  });

  it('deletes with sub-Features; ideas lose their Feature; demand counts follow', async () => {
    const a = await feature('A'); const b = await feature('B', a.id);
    const i = await idea('I', { featureId: b.id });
    let lk = await call<{ features: { id: string; allCount: number; openCount: number }[] }>(lookupsRoute, { cookie: member });
    expect(lk.body.features.find((f) => f.id === b.id)).toMatchObject({ allCount: 1, openCount: 1 });
    await call(statusRoute, { method: 'PUT', cookie: admin, params: { id: i.id }, body: { status: 'IDEA_COMPLETE' } });
    lk = await call(lookupsRoute, { cookie: member });
    expect(lk.body.features.find((f) => f.id === b.id)).toMatchObject({ allCount: 1, openCount: 0 });
    const d = await call(featureDelete, { method: 'DELETE', cookie: pm, params: { id: a.id } });
    expect(d.body).toEqual({ subFeaturesDeleted: 1, ideasDetached: 1 });
    const row = (await call<{ rows: IdeaRow[] }>(listRoute, { cookie: member, path: `/api/fh/ideas?${specQ()}` })).body.rows[0];
    expect(row.featureId).toBeNull();
    expect((await call(featureDelete, { method: 'DELETE', cookie: pm, params: { id: a.id } })).status).toBe(404);
  });

  it('rail filter by Feature, exact or with descendants (FH-004)', async () => {
    const a = await feature('A'); const b = await feature('B', a.id);
    const ia = await idea('In A', { featureId: a.id }); const ib = await idea('In B', { featureId: b.id });
    const ids = async (rail: object) => (await call<{ rows: IdeaRow[] }>(listRoute, { cookie: member, path: `/api/fh/ideas?${specQ({ rail })}` })).body.rows.map((r) => r.id).sort();
    expect(await ids({ featureId: a.id })).toEqual([ia.id]);
    expect(await ids({ featureId: a.id, includeSub: true })).toEqual([ia.id, ib.id].sort());
  });
});

describe('Journeys (FH-651–654)', () => {
  it('lists with counts; admins delete; names are unique ignoring case and spaces (INV-23)', async () => {
    const j = '0190c3a7-0000-7000-8000-000000000001';
    await ctx.pg.query(`INSERT INTO fh_journey (id, name) VALUES ($1, 'Checkout')`, [j]);
    await expect(ctx.pg.query(`INSERT INTO fh_journey (id, name) VALUES ('0190c3a7-0000-7000-8000-000000000002', 'CHECKOUT')`)).rejects.toThrow();
    const i = await idea('J');
    await ctx.pg.query(`INSERT INTO fh_idea_journey (idea_id, journey_id) VALUES ($1, $2)`, [i.id, j]);
    const r = await call<{ journeys: { ideaCount: number }[] }>(journeysGet, { cookie: member });
    expect(r.body.journeys).toEqual([expect.objectContaining({ name: 'Checkout', ideaCount: 1 })]);
    expect((await call(journeyDelete, { method: 'DELETE', cookie: member, params: { id: j } })).status).toBe(403);
    expect((await call(journeyDelete, { method: 'DELETE', cookie: admin, params: { id: j } })).body).toEqual({ membershipsRemoved: 1 });
  });
});

describe('themes (FH-701–704)', () => {
  it('seeds "UX required"; duplicates are 409 naming the existing theme; seeded cannot be deleted', async () => {
    const r = await call<{ themes: { name: string; colour: string; isSeeded: boolean }[] }>(themesGet, { cookie: member });
    expect(r.body.themes).toEqual([expect.objectContaining({ name: 'UX required', colour: '#f59e0b', isSeeded: true })]);
    const dup = await call(themesPost, { method: 'POST', cookie: admin, body: { name: ' ux REQUIRED ' } });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ message: 'A theme called "UX required" already exists.' });
    expect((await call(themesPost, { method: 'POST', cookie: admin, body: { name: 'Bad', colour: 'red' } })).status).toBe(400);
    expect((await call(themeDelete, { method: 'DELETE', cookie: admin, params: { id: UX } })).status).toBe(422);
    expect((await call(themePatch, { method: 'PATCH', cookie: admin, params: { id: UX }, body: { name: 'Design needed' } })).status).toBe(200);
    const t = await call<{ theme: { id: string } }>(themesPost, { method: 'POST', cookie: admin, body: { name: 'Perf', colour: '#AABBCC' } });
    expect(t.body.theme).toMatchObject({ colour: '#aabbcc' });
    expect((await call(themeDelete, { method: 'DELETE', cookie: admin, params: { id: t.body.theme.id } })).body).toEqual({ ideasUntagged: 0 });
  });
});

describe('milestones (FH-751, FH-752)', () => {
  it('creates, updates (empty update 400), assigns without moving dates, deletes and reports detached ideas', async () => {
    const m = await call<{ milestone: { id: string } }>(milestonesPost, { method: 'POST', cookie: admin, body: { name: 'R1', date: '2026-12-01' } });
    expect(m.status).toBe(201);
    const id = m.body.milestone.id;
    expect((await call(milestonePatch, { method: 'PATCH', cookie: admin, params: { id }, body: {} })).status).toBe(400);
    expect((await call(milestonePatch, { method: 'PATCH', cookie: admin, params: { id }, body: { date: '2026-12-15' } })).status).toBe(200);
    const i = await idea('M');
    await call(datesRoute, { method: 'PUT', cookie: admin, params: { id: i.id }, body: { startDate: '2026-01-01', dueDate: '2026-01-05' } });
    const a = await call<{ rows: IdeaRow[]; changed: number }>(assignRoute, { method: 'POST', cookie: admin, body: { ids: [i.id], milestoneId: id } });
    expect(a.body.rows[0]).toMatchObject({ milestoneId: id, startDate: '2026-01-01', dueDate: '2026-01-05' });
    expect((await call(assignRoute, { method: 'POST', cookie: admin, body: { ids: [i.id], milestoneId: MISSING } })).status).toBe(400);
    const list = await call<{ milestones: { ideaCount: number; date: string }[] }>(milestonesGet, { cookie: member });
    expect(list.body.milestones[0]).toMatchObject({ ideaCount: 1, date: '2026-12-15' });
    expect((await call(milestoneDelete, { method: 'DELETE', cookie: admin, params: { id } })).body).toEqual({ ideasDetached: 1 });
  });
});

describe('saved views (FH-901–904)', () => {
  it('built-ins are listed and fixed; members keep private views; only admins share', async () => {
    const list = await call<{ views: { name: string; builtIn: boolean; id: string }[] }>(viewsGet, { cookie: member });
    expect(list.body.views.filter((v) => v.builtIn).map((v) => v.name)).toEqual(['All', 'Triage', 'Backlog', 'Roadmap', 'Board']);
    const builtIn = list.body.views[0].id;
    expect((await call(viewDelete, { method: 'DELETE', cookie: admin, params: { id: builtIn } })).status).toBe(422);
    const cfg = { version: 1, view: 'triage', filters: { themes: [UX] }, search: 'x', columns: ['title', 'status'] };
    expect((await call(viewsPost, { method: 'POST', cookie: member, body: { name: 'Shared?', isShared: true, config: cfg } })).status).toBe(403);
    const mine = await call<{ view: { id: string } }>(viewsPost, { method: 'POST', cookie: member, body: { name: 'Mine', config: cfg } });
    expect(mine.status).toBe(201);
    expect((await call(viewsPost, { method: 'POST', cookie: member, body: { name: 'Bad', config: { version: 2, view: 'all' } } })).status).toBe(400);
    // Another user cannot see or change a private view.
    expect((await call<{ views: { id: string }[] }>(viewsGet, { cookie: pm })).body.views.map((v) => v.id)).not.toContain(mine.body.view.id);
    expect((await call(viewPatch, { method: 'PATCH', cookie: pm, params: { id: mine.body.view.id }, body: { name: 'Hijack' } })).status).toBe(404);
    expect((await call(viewPatch, { method: 'PATCH', cookie: member, params: { id: mine.body.view.id }, body: { name: 'Renamed' } })).status).toBe(200);
    const shared = await call<{ view: { id: string } }>(viewsPost, { method: 'POST', cookie: pm, body: { name: 'Team', isShared: true, config: cfg } });
    expect((await call(viewPatch, { method: 'PATCH', cookie: member, params: { id: shared.body.view.id }, body: { name: 'x' } })).status).toBe(403);
    expect((await call(viewDelete, { method: 'DELETE', cookie: admin, params: { id: shared.body.view.id } })).status).toBe(200);
    // SEC-16: a stored config with a wrong shape is read defensively.
    await ctx.pg.query(`UPDATE fh_saved_view SET config = '{"view": 42}' WHERE id = $1`, [mine.body.view.id]);
    const again = await call<{ views: { id: string; config: { view: string } }[] }>(viewsGet, { cookie: member });
    expect(again.body.views.find((v) => v.id === mine.body.view.id)!.config).toEqual({ version: 1, view: 'all' });
  });
});

describe('lookups and pickers (D-10)', () => {
  it('D-10: lookups hold no companies or people; company and person pickers are searched and capped at 50', async () => {
    await ctx.pg.exec(`INSERT INTO core_company (id, name) SELECT ('0190c3a0-0000-7000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, 'Co ' || g FROM generate_series(1, 120) g;
      INSERT INTO core_person (id, display_name, email) SELECT ('0190c3a1-0000-7000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, 'P ' || g, 'p' || g || '@x.test' FROM generate_series(1, 80) g;`);
    const lk = await call(lookupsRoute, { cookie: member });
    expect(Object.keys(lk.body).sort()).toEqual(['access', 'features', 'journeys', 'milestones', 'owners', 'settings', 'themes']);
    expect(lk.body.settings).toEqual({ currency: 'EUR', releaseTrain: { anchor: '2026-01-05', lengthDays: 21 }, planningYearStartMonth: 5 });
    expect(lk.statements).toBeLessThanOrEqual(3);
    expect((await call<{ companies: unknown[] }>(companiesGet, { cookie: member, path: '/api/fh/companies' })).body.companies).toHaveLength(50);
    expect((await call<{ companies: { name: string }[] }>(companiesGet, { cookie: member, path: '/api/fh/companies?q=co%2011' })).body.companies.map((c) => c.name)).toEqual(['Co 11', 'Co 110', 'Co 111', 'Co 112', 'Co 113', 'Co 114', 'Co 115', 'Co 116', 'Co 117', 'Co 118', 'Co 119']);
    const people = await call<{ people: Record<string, unknown>[] }>(peopleGet, { cookie: member, path: '/api/fh/people?q=p%201' });
    expect(people.body.people.length).toBeLessThanOrEqual(50);
    expect(Object.keys(people.body.people[0])).not.toContain('email');
  });
});

describe('CSV export (FH-157, SEC-18, SEC-19, PT-20)', () => {
  it('streams visible columns in order with BOM, CRLF, neutralised formulas, plain numbers, no emails; audited', async () => {
    await ctx.pg.exec(`INSERT INTO core_company (id, name, arr) VALUES ('0190c3a0-0000-7000-8000-00000000c002', '=HYPERLINK("http://x")', 250.5)`);
    const a = await idea('=1+1 sneaky');
    await call((await import('@/app/api/fh/ideas/[id]/companies/route')).PUT, { method: 'PUT', cookie: admin, params: { id: a.id }, body: { ids: ['0190c3a0-0000-7000-8000-00000000c002'] } });
    await idea('Plain, with "quotes"');
    const res = await call<string>(exportRoute, { method: 'POST', cookie: member, body: { viewSpec: { view: 'all', sort: { column: 'number', dir: 'asc' } }, columns: ['number', 'title', 'companies', 'arr'] } });
    expect(res.status).toBe(200);
    expect(res.statements).toBeLessThanOrEqual(3);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="ideas-all-\d{4}-\d{2}-\d{2}\.csv"$/);
    // UTF-8 byte-order mark: read the raw bytes, since text decoding drops it.
    const raw = await exportRoute(new NextRequest('http://localhost:3000/api/fh/ideas/export', {
      method: 'POST', headers: { cookie: member, origin: 'http://localhost:3000', 'content-type': 'application/json' },
      body: JSON.stringify({ viewSpec: { view: 'all' }, columns: ['title'] }),
    }));
    expect([...new Uint8Array(await raw.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = (res.body as unknown as string).replace(/^﻿/, '');
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('#,Title,Companies,ARR');
    expect(lines[1]).toBe(`1,'=1+1 sneaky,"'=HYPERLINK(""http://x"")",250.50`);
    expect(lines[2]).toBe('2,"Plain, with ""quotes""",,0.00');
    expect(text).not.toMatch(/@/);
    const audit = await ctx.pg.query<{ details: { rows: number } }>(`SELECT details FROM core_audit_log WHERE action = 'fh.idea.export'`);
    expect(audit.rows[0].details).toMatchObject({ rows: 2, columns: ['number', 'title', 'companies', 'arr'] });
    const sel = await call<string>(exportRoute, { method: 'POST', cookie: member, body: { viewSpec: { view: 'all' }, ids: [a.id], columns: ['title', 'nope'] } });
    expect((sel.body as unknown as string).replace(/^﻿/, '').split('\r\n')).toEqual(['Title', "'=1+1 sneaky", '']);
    expect((await call(exportRoute, { method: 'POST', cookie: member, body: { viewSpec: {}, columns: ['nope'] } })).status).toBe(400);
  });
});

describe('roadmap and board (FH-761, FH-771–774)', () => {
  it('roadmap returns roadmap-view ideas overlapping the window', async () => {
    const a = await idea('In window'); const b = await idea('Outside');
    for (const [i, s, d] of [[a, '2026-03-01', '2026-03-10'], [b, '2027-01-01', '2027-01-02']] as const) {
      await call(statusRoute, { method: 'PUT', cookie: admin, params: { id: i.id }, body: { status: 'IDEA_PLANNED' } });
      await call(datesRoute, { method: 'PUT', cookie: admin, params: { id: i.id }, body: { startDate: s, dueDate: d } });
    }
    const r = await call<{ rows: IdeaRow[] }>(roadmapRoute, { cookie: member, path: `/api/fh/roadmap?${specQ()}&from=2026-03-10&to=2026-04-01` });
    expect(r.body.rows.map((x) => x.id)).toEqual([a.id]);
    expect((await call(roadmapRoute, { cookie: member, path: `/api/fh/roadmap?${specQ()}&from=2026-04-01&to=2026-03-01` })).status).toBe(400);
  });

  it('board groups every row by status with totals, and pages a column', async () => {
    for (let k = 0; k < 53; k++) await ctx.pg.query(`INSERT INTO fh_idea (id, title, status) VALUES ($1, $2, 'OPEN')`, [`0190c3a5-0000-7000-8000-${(k + 1).toString(16).padStart(12, '0')}`, `I${k}`]);
    await ctx.pg.query(`INSERT INTO fh_idea (id, title, idea_type, bug_status) VALUES ('0190c3a5-0000-7000-8000-0000000000ff', 'Bug', 'BUG', 'FIXED')`);
    const r = await call<{ columns: { key: string; total: number; rows: IdeaRow[]; nextCursor: string | null }[] }>(boardRoute, { cookie: member, path: `/api/fh/board?${specQ()}&group=status` });
    expect(r.statements).toBeLessThanOrEqual(3);
    const open = r.body.columns.find((c) => c.key === 'IDEA_OPEN')!;
    expect(open).toMatchObject({ total: 53 });
    expect(open.rows).toHaveLength(50);
    expect(r.body.columns.find((c) => c.key === 'BUG_FIXED')!.total).toBe(1);
    const more = await call<{ columns: { rows: IdeaRow[]; nextCursor: string | null }[] }>(boardRoute, { cookie: member, path: `/api/fh/board?${specQ()}&group=status&column=IDEA_OPEN&cursor=${open.nextCursor}` });
    expect(more.body.columns[0].rows).toHaveLength(3);
    expect(new Set([...open.rows, ...more.body.columns[0].rows].map((x) => x.id)).size).toBe(53);
    expect((await call(boardRoute, { cookie: member, path: `/api/fh/board?${specQ()}&group=colour` })).status).toBe(400);
    const owners = await call<{ columns: { key: string | null }[] }>(boardRoute, { cookie: member, path: `/api/fh/board?${specQ()}&group=owner` });
    expect(owners.body.columns.map((c) => c.key)).toEqual([null]);
  });
});

describe('grants and realtime (ARC-13, §3.7)', () => {
  it('an fh_grant makes a member a feedback admin; the post-delete grant is separate and audited', async () => {
    const id = (await ctx.pg.query<{ id: string }>(`SELECT id FROM core_user WHERE email = 'member@team.test'`)).rows[0].id;
    expect((await call(featuresPost, { method: 'POST', cookie: member, body: { name: 'X' } })).status).toBe(403);
    const g = await call(fhGrantPut, { method: 'PUT', cookie: admin, params: { id }, body: { admin: true, canDeletePosts: true } });
    expect(g.body).toEqual({ grant: { userId: id, admin: true, canDeletePosts: true } });
    expect((await call(meRoute, { cookie: member })).body).toMatchObject({ isFeedbackAdmin: true, canDeletePosts: true, isWorkspaceAdmin: false });
    expect((await call(featuresPost, { method: 'POST', cookie: member, body: { name: 'X' } })).status).toBe(201);
    expect((await call(fhGrantPut, { method: 'PUT', cookie: pm, params: { id }, body: { admin: false, canDeletePosts: false } })).status).toBe(403);
    expect((await call(fhGrantPut, { method: 'PUT', cookie: admin, params: { id: MISSING }, body: { admin: false, canDeletePosts: false } })).status).toBe(404);
    const audit = await ctx.pg.query(`SELECT action FROM core_audit_log WHERE action = 'core.user.fh_grant'`);
    expect(audit.rows).toHaveLength(1);
  });

  it('members may join fh.workspace and fh.idea.<id>; without a JWT secret the client is told to poll', async () => {
    const r = await call(tokenRoute, { method: 'POST', cookie: member, body: { channels: ['fh.workspace', 'fh.idea.0190c3a5-0000-7000-8000-000000000001', 'fh.nope'] } });
    expect(r.body).toEqual({ available: false, channels: [] });
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret-0123456789';
    try {
      const ok = await call<{ channels: string[] }>(tokenRoute, { method: 'POST', cookie: member, body: { channels: ['fh.workspace', 'fh.idea.0190c3a5-0000-7000-8000-000000000001', 'fh.nope'] } });
      expect(ok.body.channels).toEqual(['fh.workspace', 'fh.idea.0190c3a5-0000-7000-8000-000000000001']);
    } finally { delete process.env.SUPABASE_JWT_SECRET; }
  });
});

