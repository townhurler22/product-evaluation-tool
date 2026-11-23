// ING-08 pipeline rows, ING-09 browser refusal, ING-11 verify, ING-12–14 receipts, ING-28–30 keys.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sql } from 'kysely';
import { freshDb } from '../db';
import { send } from '../intake-client';
import { registerIntakeRoute } from '@/modules/core/intake/registry';
import { addReview, createClient, issueKey, revokeKey, setPause } from '@/modules/core/intake/admin';
import { flushUnkeyedForTests } from '@/modules/core/intake/gateway';
import { newId } from '@/modules/core/util';
import { ApiError } from '@/server/http/errors';

process.env.INGEST_MASTER_KEY = 'test-master-key-0123456789abcdef0123';
process.env.INGEST_ENVIRONMENT = 'staging';

const created: string[] = [];
beforeAll(() => {
  // A stand-in for Feedback Hub's real routes (P2), so the generic pipeline can be tested now.
  registerIntakeRoute('fh', 'test-items', {
    bodyCap: 1024,
    schema: z.strictObject({ title: z.string().min(1).max(200) }),
    handler: async ({ tx, body, client }) => {
      if (body.title === 'refuse') throw new ApiError('rule_violation', 'Refused by handler.');
      await sql`INSERT INTO core_audit_log (id, actor_kind, actor_id, action) VALUES (${newId()}, 'ingest', ${client.clientId}, 'test.item')`.execute(tx);
      created.push(body.title);
    },
  });
});

let ctx: Awaited<ReturnType<typeof freshDb>>;
let adminId: string;
let clientId: string;
let key: { keyId: string; secret: string };

beforeEach(async () => {
  ctx = await freshDb();
  created.length = 0;
  adminId = newId();
  await ctx.pg.query(`INSERT INTO core_user (id, email, role, status) VALUES ($1, 'admin@example.com', 'ADMIN', 'ACTIVE')`, [adminId]);
  clientId = (await createClient(adminId, { name: 'Agent', environment: 'staging', routes: ['test-items'] })).id;
  key = await issueKey(adminId, clientId);
});

const body = (title = 'Export to PDF') => JSON.stringify({ title });
const logs = async () => (await ctx.pg.query<{ outcome: string; reason: string; status: number }>(
  'SELECT outcome, reason, status FROM ing_log ORDER BY created_at, id')).rows;

describe('happy path and receipts', () => {
  it('202 with a receipt id, nothing echoed', async () => {
    const r = await send({ ...key, route: 'test-items', body: body() });
    expect(r.status).toBe(202);
    expect(Object.keys(r.body)).toEqual(['receiptId']);
    expect(r.headers.get('x-ingest-receipt')).toBe(r.body.receiptId);
    expect(created).toEqual(['Export to PDF']);
    expect(await logs()).toEqual([{ outcome: 'accepted', reason: 'created', status: 202 }]);
  });

  it('same key + same body replays the stored answer and creates nothing (ING-13)', async () => {
    const a = await send({ ...key, route: 'test-items', body: body(), requestKey: 'k1' });
    const b = await send({ ...key, route: 'test-items', body: body(), requestKey: 'k1' });
    expect(b.status).toBe(202);
    expect(b.body).toEqual(a.body);
    expect(b.headers.get('x-ingest-replayed')).toBe('1');
    expect(created).toHaveLength(1);
  });

  it('same key + different body is 409 receipt_conflict (ING-14)', async () => {
    await send({ ...key, route: 'test-items', body: body('a'), requestKey: 'k1' });
    const r = await send({ ...key, route: 'test-items', body: body('b'), requestKey: 'k1' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('receipt_conflict');
  });

  it('a refused request leaves no receipt, so the sender can fix and resend (ING-12)', async () => {
    expect((await send({ ...key, route: 'test-items', body: body('refuse'), requestKey: 'k2' })).status).toBe(422);
    expect((await send({ ...key, route: 'test-items', body: body('fixed'), requestKey: 'k2' })).status).toBe(202);
  });

  it('two keys from different clients may reuse a request key', async () => {
    const other = (await createClient(adminId, { name: 'Product', environment: 'staging', routes: ['test-items'] })).id;
    const k2 = await issueKey(adminId, other);
    await send({ ...key, route: 'test-items', body: body(), requestKey: 'same' });
    expect((await send({ ...k2, route: 'test-items', body: body(), requestKey: 'same' })).headers.get('x-ingest-replayed')).toBeNull();
    expect(created).toHaveLength(2);
  });
});

describe('authentication (steps 4–8): one uniform 401', () => {
  const uniform = { code: 'unauthorised', message: 'The request could not be authenticated.' };

  it('bad signature', async () => {
    const r = await send({ ...key, secret: 'f'.repeat(64), route: 'test-items', body: body() });
    expect([r.status, r.body]).toEqual([401, uniform]);
    expect((await logs()).at(-1)).toMatchObject({ outcome: 'rejected', reason: 'bad_signature' });
  });

  it('stale timestamp (±300 s)', async () => {
    const r = await send({ ...key, route: 'test-items', body: body(), timestamp: Math.floor(Date.now() / 1000) - 301 });
    expect([r.status, r.body]).toEqual([401, uniform]);
    expect((await logs()).at(-1)).toMatchObject({ reason: 'stale_timestamp' });
  });

  it('unknown key and revoked key: no log row, unkeyed count only (ING-37)', async () => {
    expect((await send({ ...key, keyId: 'ik_nope', route: 'test-items', body: body() })).body).toEqual(uniform);
    await revokeKey(adminId, clientId, key.keyId);
    expect((await send({ ...key, route: 'test-items', body: body() })).body).toEqual(uniform);
    expect(await logs()).toEqual([]);
    await flushUnkeyedForTests();
    const { rows } = await ctx.pg.query<{ count: number }>('SELECT count FROM ing_unkeyed_count');
    expect(rows[0].count).toBeGreaterThanOrEqual(2);
  });

  it('malformed headers', async () => {
    const r = await send({ ...key, route: 'test-items', body: body(), headers: { 'x-ingest-signature': 'XYZ' } });
    expect(r.status).toBe(401);
  });

  it('a staging key never verifies on a production deployment (ING-03)', async () => {
    process.env.INGEST_ENVIRONMENT = 'production';
    try { expect((await send({ ...key, route: 'test-items', body: body() })).status).toBe(401); }
    finally { process.env.INGEST_ENVIRONMENT = 'staging'; }
  });

  it('query strings are refused before anything else is read', async () => {
    const r = await send({ ...key, route: 'test-items', body: body(), query: '?x=1' });
    expect([r.status, r.body.code]).toEqual([400, 'query_not_allowed']);
  });
});

describe('browser refusal (ING-09)', () => {
  it('(a) Origin alone → 403', async () => {
    expect((await send({ ...key, route: 'test-items', body: body(), headers: { origin: 'https://evil.test' } })).status).toBe(403);
  });
  it('(b) Sec-Fetch-Site alone → 403', async () => {
    expect((await send({ ...key, route: 'test-items', body: body(), headers: { 'sec-fetch-site': 'cross-site' } })).body.code).toBe('browser_refused');
  });
  it('(c) a lone Sec-Fetch-Mode: cors (Node fetch) is accepted', async () => {
    expect((await send({ ...key, route: 'test-items', body: body(), headers: { 'sec-fetch-mode': 'cors' } })).status).toBe(202);
  });
});

describe('later pipeline steps', () => {
  it('_verify answers 204, writes no receipt, flags a pause (ING-11)', async () => {
    expect((await send({ ...key, route: '_verify' })).status).toBe(204);
    await setPause(adminId, { module: 'fh', paused: true, reason: 'test' });
    const r = await send({ ...key, route: '_verify', requestKey: 'v2' });
    expect(r.status).toBe(204);
    expect(r.headers.get('x-ingest-paused')).toBe('1');
    const { rows } = await ctx.pg.query('SELECT 1 FROM ing_receipt');
    expect(rows).toEqual([]);
  });

  it('module pause and client pause answer 503 with Retry-After 300 (ING-35)', async () => {
    await setPause(adminId, { clientId, paused: true, reason: 'flood' });
    const r = await send({ ...key, route: 'test-items', body: body() });
    expect([r.status, r.body.code, r.headers.get('retry-after')]).toEqual([503, 'intake_paused', '300']);
    await setPause(adminId, { clientId, paused: false });
    expect((await send({ ...key, route: 'test-items', body: body() })).status).toBe(202);
  });

  it('body over the cap is 413, checked on bytes read', async () => {
    const r = await send({ ...key, route: 'test-items', body: JSON.stringify({ title: 'x'.repeat(2000) }) });
    expect([r.status, r.body.code]).toEqual([413, 'too_large']);
  });

  it('unknown route is 404 only after authentication', async () => {
    expect((await send({ ...key, route: 'nope', body: body() })).status).toBe(404);
    expect((await logs()).at(-1)).toMatchObject({ reason: 'unknown_route' });
  });

  it('route outside the client scope is 403 out_of_scope; target-scoped client is 403 target_scope', async () => {
    await ctx.pg.query(`UPDATE ing_client SET routes = '{other}' WHERE id = $1`, [clientId]);
    expect((await send({ ...key, route: 'test-items', body: body() })).body.code).toBe('out_of_scope');
    await ctx.pg.query(`UPDATE ing_client SET routes = '{test-items}', target = 'forum:abc' WHERE id = $1`, [clientId]);
    expect((await send({ ...key, route: 'test-items', body: body() })).body.code).toBe('target_scope');
  });

  it('wrong content type is 415; schema failures list paths and rules, never values (ING-10)', async () => {
    expect((await send({ ...key, route: 'test-items', body: body(), headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    const r = await send({ ...key, route: 'test-items', body: JSON.stringify({ title: 'ok', secretField: 'hunter2' }), requestKey: 'x2' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain('hunter2');
    expect(r.body.details.issues[0]).toMatch(/unrecognized_keys/);
  });

  it('per-client rate limit is shared and answers 429 with Retry-After (ING-33)', async () => {
    await ctx.pg.query('UPDATE ing_client SET rate_per_minute = 2 WHERE id = $1', [clientId]);
    await send({ ...key, route: '_verify', requestKey: 'a' });
    await send({ ...key, route: '_verify', requestKey: 'b' });
    const r = await send({ ...key, route: '_verify', requestKey: 'c' });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('503 intake_unavailable without a master key (ING-06)', async () => {
    const saved = process.env.INGEST_MASTER_KEY;
    process.env.INGEST_MASTER_KEY = 'short';
    try { expect((await send({ ...key, route: 'test-items', body: body() })).body.code).toBe('intake_unavailable'); }
    finally { process.env.INGEST_MASTER_KEY = saved; }
  });

  it('the log never holds the body or personal data (ING-36)', async () => {
    await send({ ...key, route: 'test-items', body: JSON.stringify({ title: 'jane@client.test' }) });
    const { rows } = await ctx.pg.query('SELECT * FROM ing_log');
    expect(JSON.stringify(rows)).not.toContain('jane@client.test');
    expect(JSON.stringify(rows)).not.toContain('198.51.100.20');
  });
});

describe('keys and reviews (ING-28 to ING-30)', () => {
  it('at most two active keys', async () => {
    await issueKey(adminId, clientId);
    await expect(issueKey(adminId, clientId)).rejects.toMatchObject({ status: 409 });
  });

  it('a production key needs a gateway review and a client review', async () => {
    process.env.INGEST_ENVIRONMENT = 'production';
    try {
      const prod = (await createClient(adminId, { name: 'Prod agent', environment: 'production', routes: ['test-items'] })).id;
      await expect(issueKey(adminId, prod)).rejects.toMatchObject({ status: 422 });
      await addReview(adminId, { kind: 'gateway', notes: 'Signing, order and logging reviewed.' });
      await expect(issueKey(adminId, prod)).rejects.toMatchObject({ status: 422 });
      await addReview(adminId, { kind: 'client', clientId: prod, notes: 'Secret in a vault; retries per ING-39.' });
      await expect(issueKey(adminId, prod)).resolves.toMatchObject({ keyId: expect.stringMatching(/^ik_[a-z2-7]{16}$/) });
    } finally { process.env.INGEST_ENVIRONMENT = 'staging'; }
  });

  it('the secret never reaches the audit log', async () => {
    const { rows } = await ctx.pg.query('SELECT details FROM core_audit_log');
    expect(JSON.stringify(rows)).not.toContain(key.secret);
  });
});
