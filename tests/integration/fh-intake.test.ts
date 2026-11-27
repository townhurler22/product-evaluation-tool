// P2 intake (§10.5–10.7): call requests and support submissions through the real gateway, idempotency (FH-457,
// ING-12–16), company and person resolution (ING-23, ING-24), files (ING-25, ING-26, INV-17) and D-40.
import { beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { freshDb } from '../db';
import { call, signInAll } from '../fh';
import { send } from '../intake-client';
import { flushAfterResponse } from '@/server/after';
import { drainJobs } from '@/modules/core/jobs';
import { sweepFiles } from '@/modules/core/files/service';
import { MemoryStorage, setStorage } from '@/modules/core/files/storage';
import { createClient, issueKey } from '@/modules/core/intake/admin';
import { clearSettingsCache } from '@/modules/core/settings';
import '@/server/jobs-registry';
import '@/server/registrations';
import { GET as listRoute } from '@/app/api/fh/ideas/route';
import { GET as evidenceRoute } from '@/app/api/fh/ideas/[id]/evidence/route';
import { GET as activityRoute } from '@/app/api/fh/ideas/[id]/activity/route';
import { GET as imagesRoute } from '@/app/api/fh/ideas/[id]/images/route';
import { POST as deleteRoute } from '@/app/api/fh/ideas/delete/route';
import { POST as acceptRoute } from '@/app/api/fh/ideas/bulk/accept/route';
import { DELETE as insightDelete } from '@/app/api/fh/insights/[id]/route';
import { POST as mergeRoute } from '@/app/api/fh/ideas/[id]/merge/route';
import { POST as createRoute } from '@/app/api/fh/ideas/route';
import type { IdeaRow } from '@/modules/fh/rows';

process.env.INGEST_MASTER_KEY = 'test-master-key-0123456789abcdef0123';
process.env.INGEST_ENVIRONMENT = 'staging';

let ctx: Awaited<ReturnType<typeof freshDb>>;
let admin: string;
let key: { keyId: string; secret: string };
let store: MemoryStorage;

const ADMIN_ID = '0190c3a2-0000-7000-8000-0000000000f1';
const STAFF_ID = '0190c3a2-0000-7000-8000-0000000000f2';

beforeEach(async () => {
  ctx = await freshDb();
  store = new MemoryStorage();
  setStorage(store);
  ({ admin } = await signInAll(ctx.pg));
  await ctx.pg.query(`INSERT INTO core_user (id, email, full_name, role, status) VALUES ($1, 'ops@team.test', 'Ops', 'ADMIN', 'ACTIVE'), ($2, 'sam@vendor.test', 'Sam Staff', 'MEMBER', 'ACTIVE')`, [ADMIN_ID, STAFF_ID]);
  await ctx.pg.query(`UPDATE core_setting SET value = '["vendor.test"]' WHERE key = 'intake.staff_domains'`);
  clearSettingsCache();
  const clientId = (await createClient(ADMIN_ID, { name: 'Agent', environment: 'staging', routes: ['call-requests', 'support-submissions'] })).id;
  key = await issueKey(ADMIN_ID, clientId);
});

const callBody = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'feature_request', title: 'Export to PDF', details: null, quote: 'We need PDF export', quoteVerified: true,
  requester: null, company: null,
  call: { transcriptId: 't-1', title: 'Weekly call', date: '2026-11-02', type: 'feedback_session', timeInCall: '0:12:30', link: null },
  ...over,
});
const sendCall = (body = callBody(), requestKey = 't-1:0', headers?: Record<string, string>) =>
  send({ ...key, route: 'call-requests', body, requestKey, headers });

const ideas = async () => (await ctx.pg.query<{ id: string; title: string; reviewed_at: string | null; status: string | null; bug_status: string | null; owner_id: string | null }>(
  'SELECT id, title, reviewed_at, status, bug_status, owner_id FROM fh_idea ORDER BY created_at, id')).rows;
const insights = async () => (await ctx.pg.query<{ id: string; idea_id: string; person_id: string | null; company_id: string | null; staff_user_id: string | null; source: string; meta: Record<string, unknown> }>(
  'SELECT id, idea_id, person_id, company_id, staff_user_id, source, meta FROM fh_insight ORDER BY created_at, id')).rows;
const rowOf = async (id: string) => (await call<{ rows: IdeaRow[] }>(listRoute, { cookie: admin, path: `/api/fh/ideas?ids=${id}` })).body.rows[0];

async function png(colour = '#f00') {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: colour } }).png().toBuffer();
}
const supportBody = async (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'bug', title: 'Gantt freezes', details: 'Scrolling the Gantt freezes the page',
  submitter: { email: 'ana@acme.example', name: 'Ana', externalUserId: 'u-77' },
  company: { name: 'Acme', externalAccountId: 'acc-9' },
  context: { module: 'planner', page: 'https://app.example/plan/12?token=secret#x', appVersion: '4.2' },
  attachments: [{ fileName: 'shot.png', contentType: 'image/png', dataBase64: (await png()).toString('base64') }],
  ...over,
});

describe('call requests (ING-17, ING-18, ING-22)', () => {
  it('lands Unreviewed in Open with one Call insight, an activity row and the roll-up; ≤ 14 statements in the transaction', async () => {
    const r = await sendCall();
    expect(r.status).toBe(202);
    expect(Object.keys(r.body)).toEqual(['receiptId']); // never echoes the idea, company or person (ING-04)
    const [idea] = await ideas();
    expect(idea).toMatchObject({ title: 'Export to PDF', reviewed_at: null, status: 'OPEN', owner_id: null });
    const [ins] = await insights();
    expect(ins.source).toBe('CALL');
    expect(ins.meta).toMatchObject({ v: 1, quoteVerified: true, call: { type: 'feedback_session', timeInCall: '0:12:30' } });
    const row = await rowOf(idea.id);
    expect(row).toMatchObject({ unreviewed: true, sources: ['CALL'], hasIntakeSource: true, companyMissing: true, insightCount: 1 });
    const act = await call<{ items: { to: string; actorLabel: string }[] }>(activityRoute, { cookie: admin, params: { id: idea.id } });
    expect(act.body.items.map((a) => a.to)).toContain('Created by Intake: Agent');
    // gateway: key lookup, rate window, receipt check, log, last used ≤ 5; the rest is the accepted transaction (ING-22)
    expect(Number(r.headers.get('x-statement-count'))).toBeLessThanOrEqual(19);
    await flushAfterResponse();
    await drainJobs();
    const job = await ctx.pg.query(`SELECT 1 FROM core_job WHERE kind = 'fh.match.compute' AND state = 'done'`);
    expect(job.rows.length).toBe(1);
  });

  it('bug type starts in the bug workflow; the evidence reader returns the call fields and "quote not verified"', async () => {
    await sendCall(callBody({ type: 'bug', quoteVerified: false, call: { transcriptId: 't-2', title: 'Interview', date: null, type: 'client_interview', timeInCall: '1:02:03', link: 'https://kb.example/calls/2' } }), 't-2:0');
    const [idea] = await ideas();
    expect(idea).toMatchObject({ status: null, bug_status: 'OPEN' });
    const ev = await call<{ insights: { url: string; meta: { quoteVerified: boolean; call: { type: string; link: string } } }[] }>(evidenceRoute, { cookie: admin, params: { id: idea.id } });
    expect(ev.body.insights[0].meta).toMatchObject({ quoteVerified: false, call: { type: 'client_interview', link: 'https://kb.example/calls/2' } });
    expect(ev.body.insights[0].url).toBe('https://kb.example/calls/2');
  });

  it('rejects over-length text instead of truncating, a mismatched requestKey, unknown fields and non-https links (400)', async () => {
    expect((await sendCall(callBody({ title: 'x'.repeat(201) }), 'a')).status).toBe(400);
    const mismatch = await sendCall(callBody({ requestKey: 'other' }), 'b');
    expect([mismatch.status, mismatch.body.code]).toEqual([400, 'body_invalid']);
    expect((await sendCall(callBody({ extra: 1 }), 'c')).status).toBe(400);
    const http = await sendCall(callBody({ call: { transcriptId: 't', title: null, date: null, type: 'prospect', timeInCall: '0:00:01', link: 'http://x.example' } }), 'd');
    expect(http.status).toBe(400);
    expect(JSON.stringify(http.body)).not.toContain('x.example'); // never echoes submitted values (ING-10)
    expect(await ideas()).toEqual([]);
  });

  it('sanitises text before the length check (SEC-13)', async () => {
    await sendCall(callBody({ title: '  Export​ to PDF‮  ' }), 's');
    expect((await ideas())[0].title).toBe('Export to PDF');
  });
});

describe('idempotency (ING-12 to ING-16, FH-457)', () => {
  it('FH-457: a retry with the same key never creates a second idea, even after the idea was deleted', async () => {
    const first = await sendCall();
    const [idea] = await ideas();
    expect((await call(deleteRoute, { method: 'POST', cookie: admin, body: { ids: [idea.id] } })).status).toBe(200);
    expect(await ideas()).toEqual([]);
    const again = await sendCall();
    expect(again.status).toBe(202);
    expect(again.headers.get('x-ingest-replayed')).toBe('1');
    expect(again.body).toEqual(first.body);
    expect(await ideas()).toEqual([]);
  });

  it('a retry after a merge replays and does not recreate the idea (ING-15)', async () => {
    await sendCall();
    const target = (await call<{ row: IdeaRow }>(createRoute, { method: 'POST', cookie: admin, body: { title: 'Target' } })).body.row;
    const [src] = (await ideas()).filter((i) => i.title === 'Export to PDF');
    await call(mergeRoute, { method: 'POST', cookie: admin, params: { id: src.id }, body: { targetId: target.id } });
    expect((await sendCall()).headers.get('x-ingest-replayed')).toBe('1');
    expect((await ideas()).length).toBe(2);
  });

  it('concurrent identical requests create one idea (ING-12)', async () => {
    const rs = await Promise.all([sendCall(), sendCall(), sendCall()]);
    expect(rs.map((r) => r.status)).toEqual([202, 202, 202]);
    expect(new Set(rs.map((r) => r.body.receiptId)).size).toBe(1);
    expect((await ideas()).length).toBe(1);
  });

  it('ING-16: with receipts lost but the insight kept, a resend writes nothing new and answers 202', async () => {
    await sendCall();
    await ctx.pg.query('DELETE FROM ing_receipt');
    const r = await sendCall();
    expect(r.status).toBe(202);
    expect(r.headers.get('x-ingest-replayed')).toBeNull();
    expect((await ideas()).length).toBe(1);
    const log = await ctx.pg.query<{ reason: string }>(`SELECT reason FROM ing_log ORDER BY created_at DESC, id DESC LIMIT 1`);
    expect(log.rows[0].reason).toBe('duplicate');
  });

  it('two clients may reuse a request key: intake keys are per client', async () => {
    const other = (await createClient(ADMIN_ID, { name: 'Product', environment: 'staging', routes: ['call-requests'] })).id;
    const k2 = await issueKey(ADMIN_ID, other);
    await sendCall();
    expect((await send({ ...k2, route: 'call-requests', body: callBody(), requestKey: 't-1:0' })).status).toBe(202);
    expect((await ideas()).length).toBe(2);
  });

  it('accepting keeps the idea in Triage: reviewed, status unchanged (FH-402, NFR-17 journey 2)', async () => {
    await sendCall();
    const [idea] = await ideas();
    const r = await call<{ rows: IdeaRow[] }>(acceptRoute, { method: 'POST', cookie: admin, body: { ids: [idea.id] } });
    expect(r.body.rows[0]).toMatchObject({ unreviewed: false, status: 'OPEN' });
  });
});

describe('company and person resolution (ING-23, ING-24, FH-405)', () => {
  const CO_ACME = '0190c3a0-0000-7000-8000-00000000a001';
  const CO_OTHER = '0190c3a0-0000-7000-8000-00000000a002';
  beforeEach(async () => {
    await ctx.pg.query(`INSERT INTO core_company (id, name, domain, arr, aliases, created_at) VALUES
      ($1, 'Acme', 'acme.example', 1000, '{}', now() - interval '2 days'),
      ($2, 'Other  Co', NULL, 500, '{"OC Group"}', now() - interval '1 day')`, [CO_ACME, CO_OTHER]);
  });

  it('domain before name: the stored company wins whatever name was sent', async () => {
    await sendCall(callBody({ company: { name: 'Other Co', domain: 'ACME.example' }, requester: { name: 'Ana', email: 'ana@gmail.com' } }));
    const [ins] = await insights();
    expect(ins.company_id).toBe(CO_ACME);
    expect(ins.person_id).not.toBeNull(); // a public email domain never identifies a company, but the person exists
    const [idea] = await ideas();
    expect((await rowOf(idea.id)).companyMissing).toBe(false);
  });

  it("the requester's email domain is the second candidate; public domains are skipped", async () => {
    await sendCall(callBody({ requester: { name: 'Bo', email: 'bo@acme.example' } }), 'k1');
    expect((await insights())[0].company_id).toBe(CO_ACME);
    await sendCall(callBody({ requester: { name: 'Cy', email: 'cy@gmail.com' }, company: null }), 'k2');
    expect((await insights())[1].company_id).toBeNull();
  });

  it('name match is case- and space-insensitive, aliases count; otherwise a prospect is created with the sent domain', async () => {
    await sendCall(callBody({ company: { name: ' other co ', domain: null } }), 'k1');
    await sendCall(callBody({ company: { name: 'oc group', domain: null } }), 'k2');
    await sendCall(callBody({ company: { name: 'Newco', domain: 'newco.example' } }), 'k3');
    const ins = await insights();
    expect(ins.slice(0, 2).map((i) => i.company_id)).toEqual([CO_OTHER, CO_OTHER]);
    const prospect = await ctx.pg.query<{ name: string; domain: string; prospect: boolean }>(`SELECT name, domain, prospect_at IS NOT NULL AS prospect FROM core_company WHERE id = $1`, [ins[2].company_id]);
    expect(prospect.rows[0]).toEqual({ name: 'Newco', domain: 'newco.example', prospect: true });
  });

  it('an existing person keeps set fields; empty ones are filled; INV-13 links are written', async () => {
    await ctx.pg.query(`INSERT INTO core_person (id, email, display_name) VALUES ('0190c3a1-0000-7000-8000-00000000b001', 'dee@acme.example', NULL)`);
    await sendCall(callBody({ requester: { name: 'Dee', email: 'Dee@Acme.example' } }));
    const p = await ctx.pg.query<{ display_name: string; company_id: string; company_source: string; verified_at: string | null }>(`SELECT display_name, company_id, company_source, verified_at FROM core_person`);
    expect(p.rows).toEqual([{ display_name: 'Dee', company_id: CO_ACME, company_source: 'INTAKE', verified_at: null }]); // calls are not vouched (ING-18)
    const [idea] = await ideas();
    const links = await ctx.pg.query(`SELECT (SELECT count(*)::int FROM fh_idea_company WHERE idea_id = $1) c, (SELECT count(*)::int FROM fh_idea_person WHERE idea_id = $1) p`, [idea.id]);
    expect(links.rows[0]).toEqual({ c: 1, p: 1 });
  });

  it('a name without an email gets no person row; the name is kept on the insight (ING-23)', async () => {
    await sendCall(callBody({ requester: { name: 'Eve', email: null } }));
    expect((await ctx.pg.query('SELECT 1 FROM core_person')).rows.length).toBe(0);
    expect((await insights())[0].meta.requesterName).toBe('Eve');
  });

  it('internal calls credit the staff member, have no company and never show Company missing (ING-24, OD-22)', async () => {
    await sendCall(callBody({ requester: { name: 'Sam', email: 'sam@vendor.test' }, company: { name: 'Acme', domain: 'acme.example' },
      call: { transcriptId: 't-9', title: 'Standup', date: null, type: 'internal', timeInCall: '0:01:00', link: null } }));
    const [ins] = await insights();
    expect(ins).toMatchObject({ staff_user_id: STAFF_ID, person_id: null, company_id: null });
    const [idea] = await ideas();
    expect(await rowOf(idea.id)).toMatchObject({ userCount: 0, companyCount: 0, companyMissing: false, hasIntakeSource: true });
  });

  it('a staff requester on a client call is never an external person; an unknown staff email keeps the name', async () => {
    await sendCall(callBody({ requester: { name: 'Max', email: 'max@vendor.test' } }));
    expect((await ctx.pg.query('SELECT 1 FROM core_person')).rows.length).toBe(0);
    expect((await insights())[0]).toMatchObject({ staff_user_id: null, meta: expect.objectContaining({ requesterName: 'Max' }) });
  });
});

describe('support submissions (ING-20, ING-21, ING-25)', () => {
  it('stores screenshots before rows, vouches for the submitter, strips the page query and fragment', async () => {
    const r = await send({ ...key, route: 'support-submissions', body: await supportBody(), requestKey: 's-1' });
    expect(r.status).toBe(202);
    const [ins] = await insights();
    expect(ins.source).toBe('SUPPORT_BUTTON');
    const meta = ins.meta as { context: { page: string }; externalUserId: string; externalAccountId: string; attachments: { fileId: string }[] };
    expect(meta.context.page).toBe('https://app.example/plan/12');
    expect(meta).toMatchObject({ externalUserId: 'u-77', externalAccountId: 'acc-9' });
    const file = await ctx.pg.query<{ storage_key: string }>('SELECT storage_key FROM core_file');
    expect(file.rows[0].storage_key).toBe(`fh/insight/${ins.id}/${meta.attachments[0].fileId}`);
    expect(store.objects.has(file.rows[0].storage_key)).toBe(true);
    const person = await ctx.pg.query<{ verified_by: string; company: string }>(`SELECT p.verified_by, c.name AS company FROM core_person p JOIN core_company c ON c.id = p.company_id`);
    expect(person.rows[0]).toEqual({ verified_by: 'ingest:Agent', company: 'Acme' }); // prospect from the name
    const [idea] = await ideas();
    expect(idea.bug_status).toBe('OPEN');
    const imgs = await call<{ images: { url: string; insightId: string }[] }>(imagesRoute, { cookie: admin, params: { id: idea.id } });
    expect(imgs.body.images).toHaveLength(1);
    expect(imgs.body.images[0].url).toMatch(/^https:\/\/storage\.test\//);
  });

  it('503 files_unavailable before any row when storage is down; no receipt, so a retry works', async () => {
    store.down = true;
    const r = await send({ ...key, route: 'support-submissions', body: await supportBody(), requestKey: 's-2' });
    expect([r.status, r.body.code]).toEqual([503, 'files_unavailable']);
    expect(await ideas()).toEqual([]);
    expect((await ctx.pg.query('SELECT 1 FROM ing_receipt')).rows.length).toBe(0);
    store.down = false;
    expect((await send({ ...key, route: 'support-submissions', body: await supportBody(), requestKey: 's-2' })).status).toBe(202);
  });

  it('415 for a type mismatch or a non-image; 413 over 2 MiB decoded; nothing stored', async () => {
    const mismatch = await supportBody({ attachments: [{ fileName: 'a.jpg', contentType: 'image/jpeg', dataBase64: (await png()).toString('base64') }] });
    const r1 = await send({ ...key, route: 'support-submissions', body: mismatch, requestKey: 's-3' });
    expect([r1.status, r1.body.code]).toEqual([415, 'file_type_mismatch']);
    const gif = Buffer.from('GIF89a' + 'x'.repeat(20)).toString('base64');
    const r2 = await send({ ...key, route: 'support-submissions', body: await supportBody({ attachments: [{ fileName: 'a.png', contentType: 'image/png', dataBase64: gif }] }), requestKey: 's-4' });
    expect([r2.status, r2.body.code]).toEqual([415, 'file_type_not_allowed']);
    const big = Buffer.alloc(800 * 1024, 1).toString('base64');
    const atts = [1, 2, 3].map(() => ({ fileName: 'b.png', contentType: 'image/png', dataBase64: big }));
    const r3 = await send({ ...key, route: 'support-submissions', body: await supportBody({ attachments: atts }), requestKey: 's-5' });
    expect([r3.status, r3.body.code]).toEqual([413, 'too_large']);
    expect(store.objects.size).toBe(0);
    expect(await ideas()).toEqual([]);
  });

  it('a duplicate found inside the transaction deletes the uploaded objects (ING-25)', async () => {
    await send({ ...key, route: 'support-submissions', body: await supportBody(), requestKey: 's-6' });
    await ctx.pg.query('DELETE FROM ing_receipt');
    expect(store.objects.size).toBe(1);
    expect((await send({ ...key, route: 'support-submissions', body: await supportBody(), requestKey: 's-6' })).status).toBe(202);
    expect(store.objects.size).toBe(1);
    expect((await ctx.pg.query('SELECT 1 FROM core_file')).rows.length).toBe(1);
  });
});

describe('INV-17 / ING-26: files are removed on every delete path', () => {
  async function oneWithFile() {
    await send({ ...key, route: 'support-submissions', body: await supportBody(), requestKey: `f-${Math.random()}` });
    const [ins] = (await insights()).slice(-1);
    const f = await ctx.pg.query<{ storage_key: string }>('SELECT storage_key FROM core_file WHERE owner_id = $1', [ins.id]);
    return { insight: ins, keyName: f.rows[0].storage_key };
  }

  it('deleting the insight (FH-503)', async () => {
    const { insight, keyName } = await oneWithFile();
    const r = await call<{ filesRemoved: number }>(insightDelete, { method: 'DELETE', cookie: admin, params: { id: insight.id } });
    expect(r.body.filesRemoved).toBe(1);
    expect(store.objects.has(keyName)).toBe(false);
  });

  it('bulk-deleting ideas (FH-456)', async () => {
    const { insight, keyName } = await oneWithFile();
    const r = await call<{ filesRemoved: number }>(deleteRoute, { method: 'POST', cookie: admin, body: { ids: [insight.idea_id] } });
    expect(r.body.filesRemoved).toBe(1);
    expect(store.objects.has(keyName)).toBe(false);
  });

  it('merging moves the insight and its file stays (ING-26)', async () => {
    const { insight, keyName } = await oneWithFile();
    const target = (await call<{ row: IdeaRow }>(createRoute, { method: 'POST', cookie: admin, body: { title: 'Target' } })).body.row;
    await call(mergeRoute, { method: 'POST', cookie: admin, params: { id: insight.idea_id }, body: { targetId: target.id } });
    expect(store.objects.has(keyName)).toBe(true);
    const imgs = await call<{ images: unknown[] }>(imagesRoute, { cookie: admin, params: { id: target.id } });
    expect(imgs.body.images).toHaveLength(1);
  });

  it('the nightly sweep removes files whose insight is gone (owner resolver fh/insight)', async () => {
    const { insight, keyName } = await oneWithFile();
    await ctx.pg.query('DELETE FROM fh_insight WHERE id = $1', [insight.id]); // a path that forgot its files
    expect((await sweepFiles()).orphaned).toBe(1);
    expect(store.objects.has(keyName)).toBe(false);
  });

  it('a storage failure never fails the delete; the row is marked for the sweep', async () => {
    const { insight, keyName } = await oneWithFile();
    store.failRemove = true;
    expect((await call(deleteRoute, { method: 'POST', cookie: admin, body: { ids: [insight.idea_id] } })).status).toBe(200);
    expect((await ctx.pg.query('SELECT 1 FROM core_file WHERE deleted_at IS NOT NULL')).rows.length).toBe(1);
    store.failRemove = false;
    await sweepFiles();
    expect(store.objects.has(keyName)).toBe(false);
  });
});

describe('D-40: only Origin or Sec-Fetch-Site mark a browser', () => {
  it('Origin alone → 403; Sec-Fetch-Site alone → 403; a lone Sec-Fetch-Mode is accepted', async () => {
    expect((await sendCall(callBody(), 'b1', { origin: 'https://evil.example' })).body.code).toBe('browser_refused');
    expect((await sendCall(callBody(), 'b2', { 'sec-fetch-site': 'cross-site' })).body.code).toBe('browser_refused');
    expect((await sendCall(callBody(), 'b3', { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).status).toBe(202);
    expect((await ideas()).length).toBe(1);
  });
});
