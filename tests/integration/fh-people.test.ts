// P2 companies, people and ARR (§7.14), erasure (SEC-20, FH-815), triage counts (FH-403/404) and reporting (§7.15).
import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from '../db';
import { call, signInAll, specQ } from '../fh';
import { drainJobs } from '@/modules/core/jobs';
import { enqueue } from '@/modules/core/jobs';
import { insertFileRows } from '@/modules/core/files/service';
import { MemoryStorage, setStorage } from '@/modules/core/files/storage';
import { reconcile } from '@/modules/fh/jobs';
import '@/server/jobs-registry';
import { GET as listRoute } from '@/app/api/fh/ideas/route';
import { POST as createIdea } from '@/app/api/fh/ideas/route';
import { POST as insightsRoute } from '@/app/api/fh/ideas/[id]/insights/route';
import { PUT as ideaCompanies } from '@/app/api/fh/ideas/[id]/companies/route';
import { PUT as themesRoute } from '@/app/api/fh/ideas/[id]/themes/route';
import { PATCH as patchIdea } from '@/app/api/fh/ideas/[id]/route';
import { GET as triageCountsRoute } from '@/app/api/fh/ideas/triage-counts/route';
import { GET as companiesGet, POST as companiesPost } from '@/app/api/fh/companies/route';
import { GET as companyGet, PATCH as companyPatch } from '@/app/api/fh/companies/[id]/route';
import { POST as companiesDelete } from '@/app/api/fh/companies/delete/route';
import { GET as peopleGet, POST as peoplePost } from '@/app/api/fh/people/route';
import { GET as personGet, PATCH as personPatch } from '@/app/api/fh/people/[id]/route';
import { POST as eraseRoute } from '@/app/api/fh/people/erase/route';
import { GET as reportingRoute } from '@/app/api/fh/reporting/route';
import type { IdeaRow } from '@/modules/fh/rows';

let ctx: Awaited<ReturnType<typeof freshDb>>;
let admin: string, member: string;

beforeEach(async () => {
  ctx = await freshDb();
  ({ admin, member } = await signInAll(ctx.pg));
});

const newIdea = async (title = 'Idea') => (await call<{ row: IdeaRow }>(createIdea, { method: 'POST', cookie: admin, body: { title } })).body.row;
const rowOf = async (id: string) => (await call<{ rows: IdeaRow[] }>(listRoute, { cookie: admin, path: `/api/fh/ideas?ids=${id}` })).body.rows[0];

describe('companies (FH-801 to FH-805, FH-505)', () => {
  it('creates with a normalised domain, adopts people with no company, refuses a taken domain (409)', async () => {
    await ctx.pg.query(`INSERT INTO core_person (id, email) VALUES
      ('0190c3a1-0000-7000-8000-000000000001', 'a@acme.example'), ('0190c3a1-0000-7000-8000-000000000002', 'b@other.example')`);
    const r = await call<{ company: { id: string; domain: string; arr: string }; adopted: number }>(companiesPost, {
      method: 'POST', cookie: admin, body: { name: 'Acme', domain: 'https://@Acme.example/path', arr: '1,250,000.50' } });
    expect(r.status).toBe(201);
    expect(r.body.company).toMatchObject({ domain: 'acme.example', arr: '1250000.50' });
    expect(r.body.adopted).toBe(1);
    const dup = await call(companiesPost, { method: 'POST', cookie: admin, body: { name: 'Acme 2', domain: 'acme.example' } });
    expect([dup.status, (dup.body as { message: string }).message]).toEqual([409, 'This domain belongs to Acme.']);
    expect((await call(companiesPost, { method: 'POST', cookie: admin, body: { name: 'X', arr: '1.234' } })).status).toBe(400);
    expect((await call(companiesPost, { method: 'POST', cookie: admin, body: { name: 'X', domain: 'nodot' } })).status).toBe(400);
    expect((await call(companiesPost, { method: 'POST', cookie: member, body: { name: 'X' } })).status).toBe(403);
  });

  it('lists ARR first then name with people and idea counts; detail shows people, ideas and open demand', async () => {
    const big = (await call<{ company: { id: string } }>(companiesPost, { method: 'POST', cookie: admin, body: { name: 'Big', arr: 900 } })).body.company;
    await call(companiesPost, { method: 'POST', cookie: admin, body: { name: 'Small', arr: 10 } });
    await call(companiesPost, { method: 'POST', cookie: admin, body: { name: 'Aardvark' } });
    const idea = await newIdea();
    await call(ideaCompanies, { method: 'PUT', cookie: admin, params: { id: idea.id }, body: { ids: [big.id] } });
    const list = await call<{ companies: { name: string; ideaCount: number }[]; total: number }>(companiesGet, { cookie: member, path: '/api/fh/companies?full=1' });
    expect(list.body.companies.map((c) => c.name)).toEqual(['Big', 'Small', 'Aardvark']);
    expect(list.body.companies[0].ideaCount).toBe(1);
    expect(list.body.total).toBe(3);
    const d = await call<{ company: { ideaCount: number; openDemand: number; ideas: { title: string }[] } }>(companyGet, { cookie: member, params: { id: big.id } });
    expect(d.body.company).toMatchObject({ ideaCount: 1, openDemand: 1, ideas: [{ title: 'Idea' }] });
  });

  it('an ARR change recomputes affected roll-ups in the same transaction; a domain change releases and adopts', async () => {
    const co = (await call<{ company: { id: string } }>(companiesPost, { method: 'POST', cookie: admin, body: { name: 'Acme', domain: 'acme.example', arr: 100 } })).body.company;
    const idea = await newIdea();
    await call(ideaCompanies, { method: 'PUT', cookie: admin, params: { id: idea.id }, body: { ids: [co.id] } });
    expect((await rowOf(idea.id)).arr).toBe('100.00');
    const r = await call<{ rollupsPending: boolean }>(companyPatch, { method: 'PATCH', cookie: admin, params: { id: co.id }, body: { arr: '2500' } });
    expect(r.body.rollupsPending).toBe(false);
    expect((await rowOf(idea.id)).arr).toBe('2500.00');

    await ctx.pg.query(`INSERT INTO core_person (id, email, company_id, company_source) VALUES
      ('0190c3a1-0000-7000-8000-000000000011', 'x@acme.example', $1, 'DOMAIN'),
      ('0190c3a1-0000-7000-8000-000000000012', 'y@acme.example', $1, 'MANUAL'),
      ('0190c3a1-0000-7000-8000-000000000013', 'z@acme.io', NULL, NULL)`, [co.id]);
    const moved = await call<{ adopted: number; released: number }>(companyPatch, { method: 'PATCH', cookie: admin, params: { id: co.id }, body: { domain: 'acme.io' } });
    expect(moved.body).toMatchObject({ adopted: 1, released: 1 });
    expect(await reconcile(undefined, false)).toMatchObject({ rollupDrift: 0 });
  });

  it('more than 500 affected ideas hand the recompute to a job (FH-505)', async () => {
    const co = (await call<{ company: { id: string } }>(companiesPost, { method: 'POST', cookie: admin, body: { name: 'Wide', arr: 1 } })).body.company;
    await ctx.pg.exec(`
      INSERT INTO fh_idea (id, title, status) SELECT ('0190c3a5-0000-7000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, 'Bulk ' || g, 'OPEN' FROM generate_series(1, 501) g;
      INSERT INTO fh_idea_company (idea_id, company_id) SELECT id, '${co.id}' FROM fh_idea WHERE title LIKE 'Bulk %';
      SELECT fh_rollup_refresh(ARRAY(SELECT id FROM fh_idea));`);
    const r = await call<{ rollupsPending: boolean }>(companyPatch, { method: 'PATCH', cookie: admin, params: { id: co.id }, body: { arr: 7 } });
    expect(r.body.rollupsPending).toBe(true);
    expect((await reconcile(undefined, false)).rollupDrift).toBe(501);
    await drainJobs();
    expect((await reconcile(undefined, false)).rollupDrift).toBe(0);
  });

  it('delete detaches people, unlinks insights and links, and reports counts (FH-804)', async () => {
    const co = (await call<{ company: { id: string } }>(companiesPost, { method: 'POST', cookie: admin, body: { name: 'Gone', domain: 'gone.example', arr: 50 } })).body.company;
    await ctx.pg.query(`INSERT INTO core_person (id, email, company_id, company_source) VALUES ('0190c3a1-0000-7000-8000-000000000021', 'p@gone.example', $1, 'DOMAIN')`, [co.id]);
    const idea = await newIdea();
    await call(insightsRoute, { method: 'POST', cookie: admin, params: { id: idea.id }, body: { value: 'Words', companyId: co.id } });
    const r = await call(companiesDelete, { method: 'POST', cookie: admin, body: { ids: [co.id] } });
    expect(r.body).toEqual({ deleted: 1, peopleDetached: 1, insightsUnlinked: 1, linksRemoved: 1, rollupsPending: false });
    expect(await rowOf(idea.id)).toMatchObject({ companyCount: 0, arr: '0.00' });
  });
});

describe('people (FH-811 to FH-814)', () => {
  it('creates with a unique normalised email, attributes by domain, and lists emails to admins only', async () => {
    await call(companiesPost, { method: 'POST', cookie: admin, body: { name: 'Acme', domain: 'acme.example' } });
    const r = await call<{ person: { id: string; email: string; companyName: string; companySource: string } }>(peoplePost, {
      method: 'POST', cookie: admin, body: { displayName: 'Ana', email: ' Ana@Acme.example ' } });
    expect(r.status).toBe(201);
    expect(r.body.person).toMatchObject({ email: 'ana@acme.example', companyName: 'Acme', companySource: 'DOMAIN' });
    expect((await call(peoplePost, { method: 'POST', cookie: admin, body: { email: 'ana@acme.example' } })).status).toBe(409);
    expect((await call(peoplePost, { method: 'POST', cookie: admin, body: {} })).status).toBe(400);
    const asAdmin = await call<{ people: { email: string | null }[] }>(peopleGet, { cookie: admin, path: '/api/fh/people?full=1&q=ana' });
    expect(asAdmin.body.people[0].email).toBe('ana@acme.example');
    const asMember = await call<{ people: { email: string | null }[] }>(peopleGet, { cookie: member, path: '/api/fh/people?full=1' });
    expect(asMember.body.people[0].email).toBeNull();
    const picker = await call<{ people: Record<string, unknown>[] }>(peopleGet, { cookie: admin, path: '/api/fh/people?q=ana' });
    expect(picker.body.people[0]).not.toHaveProperty('email'); // pickers never carry emails
  });

  it('detail shows insights with the idea title; a company change recomputes the roll-up', async () => {
    const co = (await call<{ company: { id: string } }>(companiesPost, { method: 'POST', cookie: admin, body: { name: 'Acme', arr: 300 } })).body.company;
    const p = (await call<{ person: { id: string } }>(peoplePost, { method: 'POST', cookie: admin, body: { displayName: 'Bo' } })).body.person;
    const idea = await newIdea('Better search');
    await call(insightsRoute, { method: 'POST', cookie: admin, params: { id: idea.id }, body: { value: 'Search is slow', personId: p.id } });
    expect((await rowOf(idea.id)).arr).toBe('0.00');
    await call(personPatch, { method: 'PATCH', cookie: admin, params: { id: p.id }, body: { companyId: co.id } });
    expect((await rowOf(idea.id)).arr).toBe('300.00');
    const d = await call<{ person: { insights: { ideaTitle: string }[]; companySource: string } }>(personGet, { cookie: member, params: { id: p.id } });
    expect(d.body.person.insights[0].ideaTitle).toBe('Better search');
    expect(d.body.person.companySource).toBe('MANUAL');
  });
});

describe('erasure (SEC-20, FH-815)', () => {
  const PERSON = '0190c3a1-0000-7000-8000-000000000031';
  const OTHER = '0190c3a1-0000-7000-8000-000000000032';
  const FORUM = '0190c3aa-0000-7000-8000-000000000001';
  const POST = '0190c3ab-0000-7000-8000-000000000001';

  it('deletes votes and recounts posts, keeps the words unattributed, removes screenshots and the person, recounts roll-ups', async () => {
    const store = new MemoryStorage();
    setStorage(store);
    const idea = await newIdea('Erasable');
    await ctx.pg.exec(`
      INSERT INTO core_person (id, email, display_name) VALUES ('${PERSON}', 'gone@x.example', 'Gone'), ('${OTHER}', 'stay@x.example', 'Stay');
      INSERT INTO fh_forum (id, name, slug, is_main) VALUES ('${FORUM}', 'Main', 'main', true);
      INSERT INTO fh_post (id, forum_id, title, author_person_id, vote_count) VALUES ('${POST}', '${FORUM}', 'Post', '${PERSON}', 2);
      INSERT INTO fh_vote (id, post_id, person_id) VALUES (gen_random_uuid(), '${POST}', '${PERSON}'), (gen_random_uuid(), '${POST}', '${OTHER}');
      INSERT INTO fh_idea_post (idea_id, post_id) VALUES ('${idea.id}', '${POST}');
      INSERT INTO fh_insight (id, idea_id, value, source, person_id, meta) VALUES
        ('0190c3a6-0000-7000-8000-000000000001', '${idea.id}', 'Their words', 'SUPPORT_BUTTON', '${PERSON}',
         '{"v":1,"externalUserId":"u1","externalAccountId":"a1","context":{"module":"m","page":null,"appVersion":null},"attachments":[{"fileId":"0190c3ad-0000-7000-8000-000000000001","name":"s.png","contentType":"image/png","size":3}]}');
      INSERT INTO fh_idea_person (idea_id, person_id) VALUES ('${idea.id}', '${PERSON}');
      SELECT fh_rollup_refresh(ARRAY['${idea.id}'::uuid]);`);
    await store.put('fh/insight/0190c3a6-0000-7000-8000-000000000001/0190c3ad-0000-7000-8000-000000000001', Buffer.from('x'), 'image/png');
    await insertFileRows(ctx.db, [{ id: '0190c3ad-0000-7000-8000-000000000001', module: 'fh', owner_kind: 'insight', owner_id: '0190c3a6-0000-7000-8000-000000000001',
      storage_key: 'fh/insight/0190c3a6-0000-7000-8000-000000000001/0190c3ad-0000-7000-8000-000000000001', content_type: 'image/png', size_bytes: 1, sha256: 'x', original_name: 's.png', created_by: null }]);
    expect((await rowOf(idea.id))).toMatchObject({ userCount: 2, voteTotal: 2 });

    expect((await call(eraseRoute, { method: 'POST', cookie: admin, body: { ids: [PERSON], confirm: 'erase' } })).status).toBe(400);
    expect((await call(eraseRoute, { method: 'POST', cookie: member, body: { ids: [PERSON], confirm: 'ERASE' } })).status).toBe(403);
    const r = await call(eraseRoute, { method: 'POST', cookie: admin, body: { ids: [PERSON, '0190c3a1-0000-7000-8000-0000000000ff'], confirm: 'ERASE' } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ erased: 1, postsRecounted: 1, filesRemoved: 1, failed: [{ id: '0190c3a1-0000-7000-8000-0000000000ff', reason: 'Not found.' }] });

    const post = await ctx.pg.query<{ vote_count: number; author_person_id: string | null }>(`SELECT vote_count, author_person_id FROM fh_post`);
    expect(post.rows[0]).toEqual({ vote_count: 1, author_person_id: null }); // recounted (§4.11)
    const ins = await ctx.pg.query<{ value: string; person_id: string | null; meta: Record<string, unknown> }>(`SELECT value, person_id, meta FROM fh_insight`);
    expect(ins.rows[0]).toEqual({ value: 'Their words', person_id: null, meta: { v: 1, context: { module: 'm', page: null, appVersion: null } } });
    expect((await ctx.pg.query(`SELECT 1 FROM core_person WHERE id = $1`, [PERSON])).rows.length).toBe(0);
    expect(store.objects.size).toBe(0);
    expect((await rowOf(idea.id))).toMatchObject({ userCount: 1, voteTotal: 1, distinctVoters: 1 });
    const audits = await ctx.pg.query<{ action: string; details: unknown }>(`SELECT action, details FROM core_audit_log WHERE action LIKE 'core.person.erase%' ORDER BY created_at, id`);
    expect(audits.rows.map((a) => a.action)).toEqual(['core.person.erase.requested', 'core.person.erase.completed']);
    expect(JSON.stringify(audits.rows)).not.toContain('gone@x.example'); // ids and counts only
    expect(await reconcile(undefined, false)).toMatchObject({ rollupDrift: 0 });
  });

  it('is idempotent: the core.erasure job re-runs safely after a partial run', async () => {
    await ctx.pg.exec(`INSERT INTO core_person (id, email) VALUES ('${PERSON}', 'gone@x.example')`);
    await enqueue('core.erasure', { personIds: [PERSON] });
    await enqueue('core.erasure', { personIds: [PERSON] });
    expect(await drainJobs()).toEqual({ ran: 2, failed: 0 });
    expect((await ctx.pg.query(`SELECT 1 FROM core_person`)).rows.length).toBe(0);
  });
});

describe('triage toolbar counts (FH-403, FH-404)', () => {
  it('source chips ignore the Source filter; Accept-all counts follow the full filter set', async () => {
    const a = await newIdea('Call one'), b = await newIdea('Support one'), c = await newIdea('Manual one');
    void c;
    await ctx.pg.exec(`
      INSERT INTO fh_insight (id, idea_id, value, source) VALUES
        (gen_random_uuid(), '${a.id}', 'q', 'CALL'), (gen_random_uuid(), '${b.id}', 'q', 'SUPPORT_BUTTON');
      UPDATE fh_idea SET reviewed_at = NULL WHERE id IN ('${a.id}', '${b.id}');
      SELECT fh_rollup_refresh(ARRAY['${a.id}'::uuid, '${b.id}'::uuid]);`);
    const r = await call<{ sources: { value: string; count: number }[]; unreviewedCalls: number; unreviewedSupport: number }>(triageCountsRoute, {
      cookie: member, path: `/api/fh/ideas/triage-counts?${specQ({ view: 'triage', filters: { source: ['CALL'] } })}` });
    expect(r.body.sources.map((s) => s.value).sort()).toEqual(['CALL', 'MANUAL', 'SUPPORT_BUTTON']);
    expect(r.body).toMatchObject({ unreviewedCalls: 1, unreviewedSupport: 0 });
    expect(r.statements).toBeLessThanOrEqual(2);
  });
});

describe('reporting (FH-851 to FH-854)', () => {
  it('reads tiles, theme trends and demand by Feature from the materialised view after a refresh', async () => {
    const a = await newIdea('One'), b = await newIdea('Two');
    await newIdea('Three');
    await call(patchIdea, { method: 'PATCH', cookie: admin, params: { id: a.id }, body: { isDealbreaker: true } });
    await ctx.pg.query(`UPDATE fh_idea SET status = 'COMPLETE' WHERE id = $1`, [b.id]);
    await call(themesRoute, { method: 'PUT', cookie: admin, params: { id: a.id }, body: { ids: ['0190c3a0-0000-7000-8000-0000000000a1'] } });
    await ctx.pg.exec(`
      INSERT INTO fh_feature (id, name, depth) VALUES ('0190c3a4-0000-7000-8000-000000000001', 'Root', 0);
      INSERT INTO fh_feature (id, parent_id, name, depth) VALUES ('0190c3a4-0000-7000-8000-000000000002', '0190c3a4-0000-7000-8000-000000000001', 'Child', 1);
      INSERT INTO fh_feature_closure VALUES ('0190c3a4-0000-7000-8000-000000000001','0190c3a4-0000-7000-8000-000000000001',0),
        ('0190c3a4-0000-7000-8000-000000000002','0190c3a4-0000-7000-8000-000000000002',0),('0190c3a4-0000-7000-8000-000000000001','0190c3a4-0000-7000-8000-000000000002',1);
      INSERT INTO fh_feature_demand (feature_id) VALUES ('0190c3a4-0000-7000-8000-000000000001'), ('0190c3a4-0000-7000-8000-000000000002');
      UPDATE fh_idea SET feature_id = '0190c3a4-0000-7000-8000-000000000002' WHERE id = '${a.id}';`);
    const before = await call<{ tiles: { total: number } }>(reportingRoute, { cookie: member });
    expect(before.body.tiles.total).toBe(0); // eventually consistent: nothing until the job runs
    await enqueue('fh.reporting.refresh', {});
    await drainJobs();
    const r = await call<{ tiles: Record<string, number>; themeTrends: { weeks: string[]; themes: { name: string; counts: number[] }[] }; demandByFeature: { name: string; openCount: number }[]; refreshedAt: string }>(reportingRoute, { cookie: member });
    expect(r.body.tiles).toEqual({ total: 3, completed: 1, incomplete: 2, dealbreakers: 1 });
    expect(r.body.themeTrends.weeks).toHaveLength(26);
    expect(r.body.themeTrends.themes[0]).toMatchObject({ name: 'UX required' });
    expect(r.body.themeTrends.themes[0].counts.at(-1)).toBe(1);
    expect(r.body.demandByFeature.map((f) => [f.name, f.openCount])).toEqual([['Child', 1], ['Root', 1]]);
    expect(r.body.refreshedAt).toBeTruthy();
    expect(r.statements).toBeLessThanOrEqual(2);
  });
});
