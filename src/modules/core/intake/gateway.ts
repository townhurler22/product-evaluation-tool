// Intake gateway pipeline (ING-08). Steps run in order and stop at the first failure.
// Steps 1–5 never write to the database; failures there only bump an in-memory counter (ING-37).
import { sql } from 'kysely';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { clientIp, hashIp, newId } from '../util';
import { maxBodyCap, moduleRoutes, type IntakeClient } from './registry';
import {
  deploymentEnvironment, deriveSecret, EMPTY_BODY_SHA256, masterKey, sha256Hex, sign, signaturesMatch, timestampFresh,
} from './signing';

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SIG_RE = /^[0-9a-f]{64}$/;
const TS_RE = /^\d{1,12}$/;
const HEADER_CAP = 8 * 1024;

type Outcome = 'accepted' | 'replayed' | 'rejected' | 'refused' | 'failed';

interface Answer { status: number; body?: unknown; headers?: Record<string, string> }

const err = (status: number, code: string, message: string, extra: Partial<Answer> = {}, details?: unknown): Answer => ({
  status, body: { code, message, ...(details ? { details } : {}) }, ...extra,
});
const UNAUTHORISED = () => err(401, 'unauthorised', 'The request could not be authenticated.');
const NOT_FOUND = () => err(404, 'not_found', 'Not found.');

// ── in-memory counters (per instance) ─────────────────────────────────────────
const ipHits = new Map<string, { minute: number; count: number }>();
function ipBrake(ip: string, limit = 60): number | null {
  const minute = Math.floor(Date.now() / 60_000);
  const e = ipHits.get(ip);
  if (!e || e.minute !== minute) { ipHits.set(ip, { minute, count: 1 }); if (ipHits.size > 50_000) ipHits.clear(); return null; }
  e.count += 1;
  return e.count > limit ? 60 - Math.floor((Date.now() / 1000) % 60) : null;
}

const unkeyed = new Map<string, number>();
let lastUnkeyedFlush = Date.now();
function countUnkeyed(module: string) {
  const day = new Date().toISOString().slice(0, 10);
  const k = `${module}|${day}`;
  unkeyed.set(k, (unkeyed.get(k) ?? 0) + 1);
}
/** Flushed at most once a minute, from the next keyed request (ING-37). */
async function maybeFlushUnkeyed(force = false) {
  if (!unkeyed.size || (!force && Date.now() - lastUnkeyedFlush < 60_000)) return;
  lastUnkeyedFlush = Date.now();
  const rows = [...unkeyed].map(([k, count]) => { const [module, day] = k.split('|'); return { module, day, count }; });
  unkeyed.clear();
  try {
    for (const r of rows) {
      await sql`INSERT INTO ing_unkeyed_count (module, day, count) VALUES (${r.module}, ${r.day}, ${r.count})
        ON CONFLICT (module, day) DO UPDATE SET count = ing_unkeyed_count.count + excluded.count`.execute(getDb());
    }
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'unkeyed flush failed', err: String(e) }));
  }
}
export const flushUnkeyedForTests = () => maybeFlushUnkeyed(true);

const fallbackClientHits = new Map<string, { minute: number; count: number }>();

/** Shared per-client limit (ING-33); falls back to per instance if the shared store fails. */
async function clientRateLimit(clientId: string, limit: number): Promise<number | null> {
  const minute = Math.floor(Date.now() / 60_000);
  const retry = 60 - Math.floor((Date.now() / 1000) % 60);
  try {
    const r = await sql<{ count: number }>`
      INSERT INTO core_rate_window (key, window_start, count) VALUES (${`ing:client:${clientId}`}, ${new Date(minute * 60_000)}, 1)
      ON CONFLICT (key, window_start) DO UPDATE SET count = core_rate_window.count + 1 RETURNING count`.execute(getDb());
    return r.rows[0].count > limit ? retry : null;
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'intake shared rate limit unavailable; per-instance fallback', err: String(e) }));
    const f = fallbackClientHits.get(clientId);
    if (!f || f.minute !== minute) { fallbackClientHits.set(clientId, { minute, count: 1 }); return null; }
    f.count += 1;
    return f.count > 60 ? retry : null;
  }
}

async function readCapped(req: Request, cap: number): Promise<Buffer | null> {
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > cap) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

interface KeyRow {
  key_id: string; key_status: string; client_id: string; client_name: string; environment: string;
  module: string; routes: string[]; target: string | null; rate_per_minute: number;
  client_paused_at: Date | null; module_paused_at: Date | null;
}

interface LogFields {
  client: KeyRow; route: string; outcome: Outcome; reason: string; status: number;
  receiptId?: string | null; bodySha?: string | null; bodyBytes?: number | null; ipHash: string | null; started: number;
}

async function writeLog(f: LogFields) {
  try {
    await getDb().insertInto('ing_log').values({
      id: newId(), client_id: f.client.client_id, key_id: f.client.key_id, route: f.route, outcome: f.outcome,
      reason: f.reason, status: f.status, receipt_id: f.receiptId ?? null, body_sha256: f.bodySha ?? null,
      body_bytes: f.bodyBytes ?? null, ip_hash: f.ipHash, latency_ms: Math.round(performance.now() - f.started),
    }).execute();
    // last_used_at moves at most once a minute per key (ING-29).
    await sql`UPDATE ing_key SET last_used_at = now()
      WHERE id = ${f.client.key_id} AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`.execute(getDb());
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'ing_log write failed', err: String(e) })); // alert (ING-36)
  }
}

/** Runs the whole pipeline. `module` and `routeName` come from the URL path. */
export async function runIntake(req: Request, module: string, routeName: string): Promise<Answer> {
  const started = performance.now();
  const url = new URL(req.url);

  // 1. Module known and has intake routes.
  const routes = moduleRoutes(module);
  if (!routes || routes.size === 0) { countUnkeyed(module); return NOT_FOUND(); }
  const master = masterKey();
  if (!master) {
    console.error(JSON.stringify({ level: 'error', msg: 'INGEST_MASTER_KEY missing or < 32 bytes' }));
    return err(503, 'intake_unavailable', 'Intake is unavailable.');
  }

  // 2. Browser refusal (ING-09): Origin or Sec-Fetch-Site only. A lone Sec-Fetch-Mode is fine.
  if (req.headers.has('origin') || req.headers.has('sec-fetch-site')) {
    countUnkeyed(module);
    return err(403, 'browser_refused', 'Intake does not accept browser requests.');
  }

  // 3. Per-IP brake, in memory.
  const ip = clientIp(req) ?? 'unknown';
  const ipRetry = ipBrake(ip);
  if (ipRetry !== null) {
    countUnkeyed(module);
    return err(429, 'rate_limited', 'Too many requests.', { headers: { 'Retry-After': String(ipRetry) } });
  }

  // 4. Headers present and well formed; header size; no query string.
  let headerBytes = 0;
  req.headers.forEach((v, k) => { headerBytes += k.length + v.length + 4; });
  if (url.search) { countUnkeyed(module); return err(400, 'query_not_allowed', 'Intake routes take no query string.'); }
  const h = (n: string) => req.headers.get(n) ?? '';
  const version = h('x-ingest-version'), keyId = h('x-ingest-key'), ts = h('x-ingest-timestamp');
  const requestKey = h('x-ingest-request-key'), signature = h('x-ingest-signature');
  if (headerBytes > HEADER_CAP || version !== '1' || !KEY_RE.test(keyId) || !TS_RE.test(ts)
      || !REQUEST_KEY_RE.test(requestKey) || !SIG_RE.test(signature)) {
    countUnkeyed(module); return UNAUTHORISED();
  }

  // 5. Key lookup: one primary-key read, no cache, pause state in the same statement (ING-35).
  const env = deploymentEnvironment();
  const keyRow = (await sql<KeyRow>`
    SELECT k.id AS key_id, k.status AS key_status, c.id AS client_id, c.name AS client_name, c.environment,
           c.module, c.routes, c.target, c.rate_per_minute, c.paused_at AS client_paused_at,
           ms.paused_at AS module_paused_at
    FROM ing_key k JOIN ing_client c ON c.id = k.client_id
    LEFT JOIN ing_module_setting ms ON ms.module = c.module
    WHERE k.id = ${keyId}`.execute(getDb())).rows[0];
  if (!keyRow || keyRow.key_status !== 'active' || keyRow.module !== module || keyRow.environment !== env) {
    countUnkeyed(module); return UNAUTHORISED();
  }
  await maybeFlushUnkeyed();
  const ipHash = hashIp(ip === 'unknown' ? null : ip);
  const log = (o: Omit<LogFields, 'client' | 'route' | 'ipHash' | 'started'>) =>
    writeLog({ ...o, client: keyRow, route: routeName, ipHash, started });

  // 6. Timestamp freshness.
  if (!timestampFresh(ts)) {
    await log({ outcome: 'rejected', reason: 'stale_timestamp', status: 401 }); return UNAUTHORISED();
  }

  // 7. Body, capped on Content-Length and on bytes actually read.
  const isVerify = routeName === '_verify';
  const cap = isVerify ? 0 : (routes.get(routeName)?.bodyCap ?? maxBodyCap(module));
  const raw = await readCapped(req, cap);
  if (!raw) {
    await log({ outcome: 'rejected', reason: 'too_large', status: 413 });
    return err(413, 'too_large', 'Request body is too large.');
  }
  const bodySha = raw.length ? sha256Hex(raw) : EMPTY_BODY_SHA256;

  // 8. Signature.
  const secret = deriveSecret(master, env, module, keyRow.client_id, keyRow.key_id);
  if (!signaturesMatch(sign(secret, ts, requestKey, url.pathname, bodySha), signature)) {
    await log({ outcome: 'rejected', reason: 'bad_signature', status: 401, bodySha, bodyBytes: raw.length });
    return UNAUTHORISED();
  }
  const base = { bodySha, bodyBytes: raw.length };

  // 9. Per-client shared rate limit.
  const retry = await clientRateLimit(keyRow.client_id, keyRow.rate_per_minute);
  if (retry !== null) {
    await log({ ...base, outcome: 'refused', reason: 'rate_limited', status: 429 });
    return err(429, 'rate_limited', 'Too many requests.', { headers: { 'Retry-After': String(retry) } });
  }

  const paused = Boolean(keyRow.module_paused_at || keyRow.client_paused_at);

  // 10. Verify answers here (ING-11).
  if (isVerify) {
    await log({ ...base, outcome: 'accepted', reason: 'verify', status: 204 });
    return { status: 204, headers: paused ? { 'x-ingest-paused': '1' } : {} };
  }

  // 11. Pause switch: module, then client.
  if (paused) {
    await log({ ...base, outcome: 'refused', reason: 'paused', status: 503 });
    return err(503, 'intake_paused', 'Intake is paused. Retry later.', { headers: { 'Retry-After': '300' } });
  }

  // 12. Route exists.
  const route = routes.get(routeName);
  if (!route) { await log({ ...base, outcome: 'rejected', reason: 'unknown_route', status: 404 }); return NOT_FOUND(); }

  // 13. Route scope and target scope (FH routes take no target, ING-02).
  if (!keyRow.routes.includes(routeName)) {
    await log({ ...base, outcome: 'refused', reason: 'out_of_scope', status: 403 });
    return err(403, 'out_of_scope', 'This client may not call this route.');
  }
  if (keyRow.target) {
    await log({ ...base, outcome: 'refused', reason: 'target_scope', status: 403 });
    return err(403, 'target_scope', 'This client is scoped to a target this route does not take.');
  }

  // 14. Receipt check.
  const replay = await checkReceipt(keyRow.client_id, requestKey, bodySha);
  if (replay) { await log({ ...base, ...replay.log }); return replay.answer; }

  // 15. Content type.
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    await log({ ...base, outcome: 'rejected', reason: 'unsupported_media_type', status: 415 });
    return err(415, 'unsupported_media_type', 'Send application/json.');
  }

  // 16. Parse and validate against the strict schema. Issue paths and rule names only (ING-10).
  let json: unknown;
  try { json = JSON.parse(raw.toString('utf8')); } catch {
    await log({ ...base, outcome: 'rejected', reason: 'body_invalid', status: 400 });
    return err(400, 'body_invalid', 'The body is not valid JSON.');
  }
  const parsed = route.schema.safeParse(json);
  if (!parsed.success) {
    await log({ ...base, outcome: 'rejected', reason: 'body_invalid', status: 400 });
    const issues = parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`);
    return err(400, 'body_invalid', 'The body does not match the schema.', {}, { issues });
  }

  // 17. Handler + receipt in one transaction (ING-12).
  const receiptId = newId();
  const responseBody = JSON.stringify({ receiptId });
  const client: IntakeClient = { clientId: keyRow.client_id, clientName: keyRow.client_name, keyId: keyRow.key_id, module };
  try {
    const won = await getDb().transaction().execute(async (tx) => {
      const ins = await sql<{ id: string }>`
        INSERT INTO ing_receipt (id, client_id, request_key, body_sha256, status, content_type, response_body)
        VALUES (${receiptId}, ${client.clientId}, ${requestKey}, ${bodySha}, 202, 'application/json', ${responseBody})
        ON CONFLICT (client_id, request_key) DO NOTHING RETURNING id`.execute(tx);
      if (!ins.rows.length) return false; // a concurrent identical request committed first
      await route.handler({ tx, client, requestKey, receiptId, body: parsed.data });
      return true;
    });
    if (!won) {
      const again = await checkReceipt(keyRow.client_id, requestKey, bodySha);
      await log({ ...base, ...again!.log });
      return again!.answer;
    }
  } catch (e) {
    if (e instanceof ApiError) {
      await log({ ...base, outcome: 'rejected', reason: e.code, status: e.status });
      return err(e.status, e.code, e.message, {}, e.details);
    }
    await log({ ...base, outcome: 'failed', reason: 'internal', status: 500 });
    console.error(JSON.stringify({ level: 'error', msg: 'intake handler failed', route: routeName, err: String(e) }));
    return err(500, 'internal', 'Something went wrong');
  }
  await log({ ...base, outcome: 'accepted', reason: 'created', status: 202, receiptId });
  return { status: 202, body: { receiptId }, headers: { 'x-ingest-receipt': receiptId } };
}

async function checkReceipt(clientId: string, requestKey: string, bodySha: string) {
  const r = (await sql<{ id: string; body_sha256: string; status: number; response_body: string | null }>`
    SELECT id, body_sha256, status, response_body FROM ing_receipt
    WHERE client_id = ${clientId} AND request_key = ${requestKey}`.execute(getDb())).rows[0];
  if (!r) return null;
  if (r.body_sha256 !== bodySha) {
    return {
      log: { outcome: 'rejected' as const, reason: 'receipt_conflict', status: 409 },
      answer: err(409, 'receipt_conflict', 'This request key was already used with a different body.'),
    };
  }
  return {
    log: { outcome: 'replayed' as const, reason: 'replay', status: r.status, receiptId: r.id },
    answer: {
      status: r.status,
      body: r.response_body ? JSON.parse(r.response_body) : undefined,
      headers: { 'x-ingest-replayed': '1', 'x-ingest-receipt': r.id },
    },
  };
}
