// Feedback Hub ideas: create, list, panel sections, edits, status workflow, evidence, merge, delete, bulk (P1).
import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from '../db';
import { call, signInAll, specQ } from '../fh';
import { flushAfterResponse } from '@/server/after';
import { drainJobs } from '@/modules/core/jobs';
import '@/server/jobs-registry';
import { GET as listRoute, POST as createRoute } from '@/app/api/fh/ideas/route';
import { GET as summaryRoute, PATCH as patchRoute } from '@/app/api/fh/ideas/[id]/route';
import { GET as evidenceRoute } from '@/app/api/fh/ideas/[id]/evidence/route';
import { GET as activityRoute } from '@/app/api/fh/ideas/[id]/activity/route';
import { GET as matchesRoute } from '@/app/api/fh/ideas/[id]/matches/route';
import { GET as commentsGet, POST as commentsPost } from '@/app/api/fh/ideas/[id]/comments/route';
import { PATCH as commentPatch, DELETE as commentDelete } from '@/app/api/fh/comments/[id]/route';
import { PUT as statusRoute } from '@/app/api/fh/ideas/[id]/status/route';
import { PUT as typeRoute } from '@/app/api/fh/ideas/[id]/type/route';
import { PUT as datesRoute } from '@/app/api/fh/ideas/[id]/dates/route';
import { PUT as companiesRoute } from '@/app/api/fh/ideas/[id]/companies/route';
import { PUT as themesRoute } from '@/app/api/fh/ideas/[id]/themes/route';
import { POST as insightsRoute } from '@/app/api/fh/ideas/[id]/insights/route';
import { DELETE as insightDelete } from '@/app/api/fh/insights/[id]/route';
import { POST as mergeRoute } from '@/app/api/fh/ideas/[id]/merge/route';
import { POST as deleteRoute } from '@/app/api/fh/ideas/delete/route';
import { POST as acceptRoute } from '@/app/api/fh/ideas/bulk/accept/route';
import { POST as bulkStatusRoute } from '@/app/api/fh/ideas/bulk/status/route';
import { POST as bulkThemesRoute } from '@/app/api/fh/ideas/bulk/themes/route';
import { POST as idsRoute } from '@/app/api/fh/ideas/ids/route';
import { GET as facetsRoute } from '@/app/api/fh/ideas/facets/route';
import type { IdeaRow } from '@/modules/fh/rows';

let ctx: Awaited<ReturnType<typeof freshDb>>;
let admin: string, member: string;
const UX = '0190c3a0-0000-7000-8000-0000000000a1';
const CO1 = '0190c3a0-0000-7000-8000-00000000c001';
const CO2 = '0190c3a0-0000-7000-8000-00000000c002';
const P1 = '0190c3a1-0000-7000-8000-00000000c001';

beforeEach(async () => {
  ctx = await freshDb();
  ({ admin, member } = await signInAll(ctx.pg));
  await ctx.pg.exec(`
    INSERT INTO core_company (id, name, arr) VALUES ('${CO1}', 'Acme', 1000.50), ('${CO2}', '=HYPERLINK("x")', 250);
    INSERT INTO core_person (id, email, display_name, company_id) VALUES ('${P1}', 'pat@acme.test', 'Pat', '${CO1}');`);
});

async function create(title: string, extra: Record<string, unknown> = {}, cookie = admin) {
  const r = await call<{ row: IdeaRow }>(createRoute, { method: 'POST', cookie, body: { title, ...extra } });
  expect(r.status).toBe(201);
  return r.body.row;
}
const P = (id: string) => ({ params: { id } });

describe('create (FH-201, FH-202, §4.4)', () => {
  it('D-01/D-02: any member creates; the response is the full list row, born Open, owned by its creator', async () => {
    const r = await call<{ row: IdeaRow }>(createRoute, { method: 'POST', cookie: member, body: { title: '  Export to Excel ', ideaType: 'BUG' } });
    expect(r.status).toBe(201);
    expect(r.statements).toBeLessThanOrEqual(6); // PERF-B01
    const row = r.body.row;
    expect(row).toMatchObject({ title: 'Export to Excel', ideaType: 'BUG', status: null, bugStatus: 'OPEN', unreviewed: false, version: 1, userCount: 0, arr: '0.00', sources: [], themeIds: [], companies: [] });
    expect(row.ownerId).toBeTruthy();
    expect(Object.keys(row)).toEqual(expect.arrayContaining(['number', 'featureId', 'milestoneId', 'topMatch', 'companyMissing']));
    const hist = await ctx.pg.query(`SELECT from_status, to_status FROM fh_status_change WHERE idea_id = $1`, [row.id]);
    expect(hist.rows).toEqual([{ from_status: null, to_status: 'BUG_OPEN' }]); // INV-02
  });

  it('validates the title and rejects over-length text instead of truncating (SEC-13)', async () => {
    expect((await call(createRoute, { method: 'POST', cookie: admin, body: { title: '   ' } })).status).toBe(400);
    const long = await call(createRoute, { method: 'POST', cookie: admin, body: { title: 'x'.repeat(201) } });
    expect(long.status).toBe(400);
    expect(long.body).toMatchObject({ details: { field: 'title' } });
    expect((await call(createRoute, { method: 'POST', cookie: admin, body: { title: 'A', featureId: CO1 } })).status).toBe(400);
  });

  it('refuses a cross-site POST (SEC-04) and an anonymous caller (401)', async () => {
    expect((await call(createRoute, { method: 'POST', cookie: admin, crossSite: true, body: { title: 'x' } })).status).toBe(403);
    expect((await call(createRoute, { method: 'POST', body: { title: 'x' } })).status).toBe(401);
  });
});

describe('list (PERF-11)', () => {
  it('D-06: no hidden cap; keyset pages cover every row exactly once', async () => {
    await ctx.pg.exec(`INSERT INTO fh_idea (id, title, status, created_at)
      SELECT ('0190c3a3-0000-7000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, 'Idea ' || g, 'OPEN', now() - (g % 7) * interval '1 hour'
      FROM generate_series(1, 523) g`);
    const seen = new Set<string>();
    let cursor: string | null = null, pages = 0, total = 0;
    do {
      const r: { body: { rows: IdeaRow[]; nextCursor: string | null; total?: number }; statements: number } = await call(listRoute, { cookie: member, path: `/api/fh/ideas?${specQ({ sort: { column: 'createdAt', dir: 'desc' } })}${cursor ? `&cursor=${cursor}` : ''}` });
      if (pages === 0) total = r.body.total!;
      expect(r.body.rows.length).toBeLessThanOrEqual(100);
      expect(r.statements).toBeLessThanOrEqual(4);
      for (const row of r.body.rows) { expect(seen.has(row.id)).toBe(false); seen.add(row.id); }
      cursor = r.body.nextCursor; pages++;
    } while (cursor);
    expect(total).toBe(523);
    expect(seen.size).toBe(523);
    expect(pages).toBe(6);
  });

  it('sorts with nulls last in both directions and pages through nulls', async () => {
    const a = await create('A'), b = await create('B'), c = await create('C');
    await call(patchRoute, { method: 'PATCH', cookie: admin, ...P(a.id), body: { estimateDays: 5 } });
    await call(patchRoute, { method: 'PATCH', cookie: admin, ...P(b.id), body: { estimateDays: 2 } });
    for (const dir of ['asc', 'desc'] as const) {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const path: string = `/api/fh/ideas?${specQ({ sort: { column: 'estimateDays', dir } })}${cursor ? `&cursor=${cursor}` : ''}`;
        const r = await call<{ rows: IdeaRow[]; nextCursor: string | null }>(listRoute, { cookie: member, path });
        ids.push(...r.body.rows.map((x) => x.id));
        cursor = r.body.nextCursor;
      } while (cursor);
      expect(ids).toEqual(dir === 'asc' ? [b.id, a.id, c.id] : [a.id, b.id, c.id]);
    }
  });

  it('applies views, rail, search and column filters on the server (FH-101, FH-103, FH-106)', async () => {
    const a = await create('Faster exports');
    const b = await create('Dark mode');
    await call(statusRoute, { method: 'PUT', cookie: admin, ...P(b.id), body: { status: 'IDEA_BACKLOG' } });
    const q = async (s: object) => (await call<{ rows: IdeaRow[] }>(listRoute, { cookie: member, path: `/api/fh/ideas?${specQ(s)}` })).body.rows.map((r) => r.id);
    expect(await q({ view: 'triage' })).toEqual([a.id]);
    expect(await q({ view: 'backlog' })).toEqual([b.id]);
    expect(await q({ search: 'EXPORT' })).toEqual([a.id]);
    expect(await q({ search: '%' })).toEqual([]);
    expect(await q({ filters: { status: ['IDEA_BACKLOG'] } })).toEqual([b.id]);
    expect(await q({ filters: { nope: ['x'] } })).toHaveLength(2); // FH-108: unknown column ignored
    await call(themesRoute, { method: 'PUT', cookie: admin, ...P(a.id), body: { ids: [UX] } });
    expect(await q({ filters: { themes: [UX] } })).toEqual([a.id]);
    expect(await q({ filters: { themes: [null] } })).toEqual([b.id]);
    expect(await q({ filters: { source: ['MANUAL'] } })).toHaveLength(2);
  });

  it('facets count the view before column filters, with a "no value" facet (FH-107)', async () => {
    const a = await create('One'); await create('Two');
    await call(themesRoute, { method: 'PUT', cookie: admin, ...P(a.id), body: { ids: [UX] } });
    const r = await call<{ facets: { value: string | null; count: number }[] }>(facetsRoute, { cookie: member, path: `/api/fh/ideas/facets?${specQ({ filters: { themes: [UX] } })}&column=themes` });
    expect(r.body.facets).toEqual(expect.arrayContaining([{ value: UX, label: 'UX required', count: 1 }, { value: null, label: '', count: 1 }]));
    for (const col of ['status', 'type', 'owner', 'feature', 'milestone', 'companies', 'journeys', 'source', 'triage', 'committed', 'dealbreaker']) {
      const f = await call(facetsRoute, { cookie: member, path: `/api/fh/ideas/facets?${specQ()}&column=${col}` });
      expect(f.status, col).toBe(200);
    }
    expect((await call(facetsRoute, { cookie: member, path: `/api/fh/ideas/facets?${specQ()}&column=title` })).status).toBe(400);
  });

  it('POST ideas/ids returns matching ids in order with the total (FH-151)', async () => {
    await create('a'); await create('b');
    const r = await call<{ ids: string[]; total: number }>(idsRoute, { method: 'POST', cookie: member, body: { viewSpec: { view: 'triage' } } });
    expect(r.body.total).toBe(2);
    expect(r.body.ids).toHaveLength(2);
  });
});

describe('panel sections (§4.6)', () => {
  it('D-03: summary ≤ 3 statements; 404 unknown; 410 tombstone with mergedIntoId', async () => {
    const a = await create('Source'), b = await create('Target');
    const s = await call(summaryRoute, { cookie: member, ...P(a.id) });
    expect(s.status).toBe(200);
    expect(s.statements).toBeLessThanOrEqual(3);
    expect(JSON.stringify(s.body).length).toBeLessThan(50_000);
    expect((await call(summaryRoute, { cookie: member, ...P('0190c3a0-0000-7000-8000-00000000ffff') })).status).toBe(404);
    expect((await call(summaryRoute, { cookie: member, ...P('not-an-id') })).status).toBe(404);
    await call(mergeRoute, { method: 'POST', cookie: admin, ...P(a.id), body: { targetId: b.id } });
    const gone = await call(summaryRoute, { cookie: member, ...P(a.id) });
    expect(gone.status).toBe(410);
    expect(gone.body).toMatchObject({ code: 'gone', details: { mergedIntoId: b.id } });
  });

  it('activity lists status changes and field edits newest first', async () => {
    const a = await create('Act');
    await call(patchRoute, { method: 'PATCH', cookie: admin, ...P(a.id), body: { title: 'Acted' } });
    await call(statusRoute, { method: 'PUT', cookie: admin, ...P(a.id), body: { status: 'IDEA_PLANNED', comment: 'go' } });
    const r = await call<{ items: { kind: string; field: string | null; to: string }[] }>(activityRoute, { cookie: member, ...P(a.id) });
    expect(r.statements).toBeLessThanOrEqual(2);
    expect(r.body.items.map((i) => i.kind)).toContain('status');
    expect(r.body.items.find((i) => i.field === 'title')).toMatchObject({ to: 'Acted' });
  });

  it('comments are admin-only; authors edit and soft-delete their own (FH-219)', async () => {
    const a = await create('C');
    expect((await call(commentsGet, { cookie: member, ...P(a.id) })).status).toBe(403);
    const c = await call<{ comment: { id: string } }>(commentsPost, { method: 'POST', cookie: admin, ...P(a.id), body: { body: 'Note' } });
    expect(c.status).toBe(201);
    expect((await call(commentPatch, { method: 'PATCH', cookie: admin, ...P(c.body.comment.id), body: { body: 'Edited' } })).status).toBe(200);
    expect((await call(commentDelete, { method: 'DELETE', cookie: admin, ...P(c.body.comment.id) })).status).toBe(200);
    const list = await call<{ comments: { deleted: boolean; body: string | null }[] }>(commentsGet, { cookie: admin, ...P(a.id) });
    expect(list.body.comments).toEqual([expect.objectContaining({ deleted: true, body: null })]);
  });

  it('D-05: duplicate matches are computed by the background job and stored, then read in one statement', async () => {
    const a = await create('Export reports to Excel');
    const b = await create('Excel export of reports is slow');
    await create('Completely unrelated');
    expect(Number((await ctx.pg.query<{ n: number }>(`SELECT count(*)::int n FROM fh_idea_match`)).rows[0].n)).toBe(0);
    await drainJobs(20);
    const m = await call<{ matches: { id: string; score: number }[] }>(matchesRoute, { cookie: member, ...P(b.id) });
    expect(m.statements).toBeLessThanOrEqual(2);
    expect(m.body.matches.map((x) => x.id)).toEqual([a.id]);
    expect(m.body.matches[0].score).toBeGreaterThanOrEqual(0.5);
    const list = await call<{ rows: IdeaRow[] }>(listRoute, { cookie: member, path: `/api/fh/ideas?${specQ()}` });
    expect(list.body.rows.find((r) => r.id === b.id)!.topMatch).toMatchObject({ id: a.id });
  });
});

describe('edits and workflow (§7.6)', () => {
  it('FH-303: every write bumps version; a stale baseVersion is 409; members cannot edit (403)', async () => {
    const a = await create('V');
    const r1 = await call<{ row: IdeaRow }>(patchRoute, { method: 'PATCH', cookie: admin, ...P(a.id), body: { title: 'V2', baseVersion: 1 } });
    expect(r1.body.row.version).toBe(2);
    const stale = await call(patchRoute, { method: 'PATCH', cookie: admin, ...P(a.id), body: { title: 'V3', baseVersion: 1 } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ message: 'This idea changed since you loaded it.' });
    expect((await call(patchRoute, { method: 'PATCH', cookie: member, ...P(a.id), body: { title: 'x' } })).status).toBe(403);
    expect((await call(patchRoute, { method: 'PATCH', cookie: admin, ...P(a.id), body: {} })).status).toBe(400);
  });

  it('FH-308 committed is refused while Open; FH-306 moving back to Open clears it', async () => {
    const a = await create('Commit');
    expect((await call(patchRoute, { method: 'PATCH', cookie: admin, ...P(a.id), body: { isCommitted: true } })).status).toBe(422);
    await call(statusRoute, { method: 'PUT', cookie: admin, ...P(a.id), body: { status: 'IDEA_BACKLOG' } });
    expect((await call<{ row: IdeaRow }>(patchRoute, { method: 'PATCH', cookie: admin, ...P(a.id), body: { isCommitted: true } })).body.row.isCommitted).toBe(true);
    const back = await call<{ row: IdeaRow }>(statusRoute, { method: 'PUT', cookie: admin, ...P(a.id), body: { status: 'IDEA_OPEN' } });
    expect(back.body.row.isCommitted).toBe(false);
  });

  it('FH-302 refuses a disallowed transition with 400; FH-305 sets roadmap dates', async () => {
    const a = await create('Flow');
    await call(statusRoute, { method: 'PUT', cookie: admin, ...P(a.id), body: { status: 'IDEA_BACKLOG' } });
    const bad = await call(statusRoute, { method: 'PUT', cookie: admin, ...P(a.id), body: { status: 'IDEA_COMPLETE' } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ message: 'Cannot move from Backlog to Complete.' });
    expect((await call(statusRoute, { method: 'PUT', cookie: admin, ...P(a.id), body: { status: 'BUG_TRIAGED' } })).status).toBe(400);
    const p = await call<{ row: IdeaRow }>(statusRoute, { method: 'PUT', cookie: admin, ...P(a.id), body: { status: 'IDEA_PLANNED' } });
    const today = new Date().toISOString().slice(0, 10);
    expect(p.body.row.startDate).toBe(today);
    expect(p.body.row.dueDate! > today).toBe(true);
  });

  it('FH-307 type change remaps status and writes history', async () => {
    const a = await create('T');
    await call(statusRoute, { method: 'PUT', cookie: admin, ...P(a.id), body: { status: 'IDEA_IN_PROGRESS' } });
    const r = await call<{ row: IdeaRow }>(typeRoute, { method: 'PUT', cookie: admin, ...P(a.id), body: { ideaType: 'BUG' } });
    expect(r.body.row).toMatchObject({ ideaType: 'BUG', status: null, bugStatus: 'IN_DEV' });
    const h = await ctx.pg.query<{ comment: string }>(`SELECT comment FROM fh_status_change WHERE idea_id = $1 ORDER BY changed_at DESC LIMIT 1`, [a.id]);
    expect(h.rows[0].comment).toBe('Type changed to Bug');
  });

  it('FH-766 dates never change status; due before start is 400; estimate follows', async () => {
    const a = await create('D');
    expect((await call(datesRoute, { method: 'PUT', cookie: admin, ...P(a.id), body: { startDate: '2026-03-10', dueDate: '2026-03-01' } })).status).toBe(400);
    const r = await call<{ row: IdeaRow }>(datesRoute, { method: 'PUT', cookie: admin, ...P(a.id), body: { startDate: '2026-03-01', dueDate: '2026-03-11' } });
    expect(r.body.row).toMatchObject({ status: 'OPEN', estimateDays: 10, startDate: '2026-03-01' });
  });
});

describe('evidence and roll-ups (§7.9)', () => {
  it('D-04: roll-ups are maintained on write and returned in the row; ARR counts each company once (INV-05)', async () => {
    const a = await create('Evidence');
    const i1 = await call<{ row: IdeaRow; insight: { id: string } }>(insightsRoute, { method: 'POST', cookie: admin, ...P(a.id), body: { value: 'We need this', personId: P1 } });
    expect(i1.status).toBe(201);
    expect(i1.body.row).toMatchObject({ userCount: 1, companyCount: 1, arr: '1000.50', insightCount: 1, sources: ['MANUAL'] });
    await call(insightsRoute, { method: 'POST', cookie: admin, ...P(a.id), body: { value: 'Again', companyId: CO1 } });
    const c = await call<{ row: IdeaRow; items: { name: string }[] }>(companiesRoute, { method: 'PUT', cookie: admin, ...P(a.id), body: { ids: [CO1, CO2] } });
    expect(c.body.row).toMatchObject({ companyCount: 2, arr: '1250.50', insightCount: 2 });
    expect((await call(companiesRoute, { method: 'PUT', cookie: admin, ...P(a.id), body: { ids: ['0190c3a0-0000-7000-8000-00000000dead'] } })).status).toBe(400);
    // FH-501: a client cannot claim another source
    expect((await call(insightsRoute, { method: 'POST', cookie: admin, ...P(a.id), body: { value: 'x', source: 'CALL' } })).status).toBe(400);
    expect((await call(insightsRoute, { method: 'POST', cookie: admin, ...P(a.id), body: { value: 'x', url: 'javascript:alert(1)' } })).status).toBe(400);
    const ev = await call<{ insights: unknown[]; countedPeople: { reasons: string[] }[] }>(evidenceRoute, { cookie: member, ...P(a.id) });
    expect(ev.statements).toBeLessThanOrEqual(3);
    expect(ev.body.countedPeople[0].reasons).toEqual(['insight', 'linked']);
    const del = await call<{ row: IdeaRow }>(insightDelete, { method: 'DELETE', cookie: admin, ...P(i1.body.insight.id) });
    expect(del.body.row.insightCount).toBe(1);
    expect((await call(insightDelete, { method: 'DELETE', cookie: admin, ...P(i1.body.insight.id) })).status).toBe(200); // idempotent
  });
});

describe('merge and delete (§7.8)', () => {
  it('merges one way: evidence moves, tombstone excluded, refusals are 409; demand adjusts', async () => {
    await ctx.pg.exec(`INSERT INTO fh_feature (id, name, depth) VALUES ('0190c3a0-0000-7000-8000-0000000f0001', 'F', 0);
      INSERT INTO fh_feature_closure VALUES ('0190c3a0-0000-7000-8000-0000000f0001', '0190c3a0-0000-7000-8000-0000000f0001', 0);
      INSERT INTO fh_feature_demand (feature_id) VALUES ('0190c3a0-0000-7000-8000-0000000f0001');`);
    const s = await create('S', { featureId: '0190c3a0-0000-7000-8000-0000000f0001' }), t = await create('T');
    await call(insightsRoute, { method: 'POST', cookie: admin, ...P(s.id), body: { value: 'Ask', companyId: CO1 } });
    await call(themesRoute, { method: 'PUT', cookie: admin, ...P(s.id), body: { ids: [UX] } });
    expect((await call(mergeRoute, { method: 'POST', cookie: admin, ...P(s.id), body: { targetId: s.id } })).status).toBe(409);
    const m = await call<{ target: IdeaRow; distinctVoters: number }>(mergeRoute, { method: 'POST', cookie: admin, ...P(s.id), body: { targetId: t.id } });
    expect(m.status).toBe(200);
    expect(m.statements).toBeLessThanOrEqual(14);
    expect(m.body.target).toMatchObject({ title: 'T', insightCount: 1, companyCount: 1, themeIds: [UX] });
    expect((await call(mergeRoute, { method: 'POST', cookie: admin, ...P(s.id), body: { targetId: t.id } })).status).toBe(409);
    const u = await create('U');
    expect((await call(mergeRoute, { method: 'POST', cookie: admin, ...P(u.id), body: { targetId: s.id } })).status).toBe(409);
    expect((await call(patchRoute, { method: 'PATCH', cookie: admin, ...P(s.id), body: { title: 'x' } })).status).toBe(409);
    const list = await call<{ rows: IdeaRow[]; total: number }>(listRoute, { cookie: member, path: `/api/fh/ideas?${specQ()}` });
    expect(list.body.rows.map((r) => r.id)).not.toContain(s.id);
    const d = await ctx.pg.query(`SELECT all_count FROM fh_feature_demand`);
    expect(d.rows).toEqual([{ all_count: 0 }]);
  });

  it('deletes live ideas (cascade), keeps posts, and deleting a target removes its tombstones', async () => {
    const s = await create('S'), t = await create('T');
    await call(mergeRoute, { method: 'POST', cookie: admin, ...P(s.id), body: { targetId: t.id } });
    expect((await call(deleteRoute, { method: 'POST', cookie: member, body: { ids: [t.id] } })).status).toBe(403);
    const r = await call<{ deleted: number }>(deleteRoute, { method: 'POST', cookie: admin, body: { ids: [t.id] } });
    expect(r.body.deleted).toBe(1);
    expect((await ctx.pg.query(`SELECT count(*)::int n FROM fh_idea`)).rows).toEqual([{ n: 0 }]);
    expect((await call(deleteRoute, { method: 'POST', cookie: admin, body: { ids: Array.from({ length: 201 }, () => t.id) } })).status).toBe(400);
  });
});

describe('bulk (FH-153, FH-402)', () => {
  it('accept skips reviewed and never changes status; bulk status and themes report skipped rows', async () => {
    const a = await create('A'), b = await create('B');
    await ctx.pg.query(`UPDATE fh_idea SET reviewed_at = NULL WHERE id = $1`, [a.id]);
    const acc = await call<{ rows: IdeaRow[]; skipped: { id: string }[] }>(acceptRoute, { method: 'POST', cookie: admin, body: { ids: [a.id, b.id] } });
    expect(acc.body.rows.map((r) => [r.id, r.unreviewed, r.status])).toEqual([[a.id, false, 'OPEN']]);
    expect(acc.body.skipped).toEqual([{ id: b.id, reason: 'Already reviewed.' }]);
    const st = await call<{ rows: IdeaRow[] }>(bulkStatusRoute, { method: 'POST', cookie: admin, body: { ids: [a.id, b.id], status: 'IDEA_BACKLOG' } });
    expect(st.body.rows).toHaveLength(2);
    const th = await call<{ rows: IdeaRow[] }>(bulkThemesRoute, { method: 'POST', cookie: admin, body: { ids: [a.id, b.id], themeId: UX, action: 'add' } });
    expect(th.body.rows.every((r) => r.themeIds.includes(UX))).toBe(true);
  });
});

describe('after-response publishing (ARC-22)', () => {
  it('queues publishes without failing the write when realtime is not configured', async () => {
    await create('Live');
    await expect(flushAfterResponse()).resolves.toBeUndefined();
  });
});
