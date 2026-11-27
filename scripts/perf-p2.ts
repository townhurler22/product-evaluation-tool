// P2 acceptance timings on a deployed environment: `pnpm perf:p2 https://<deployment>`
//   PT-17  duplicate match read (GET ideas/:id/matches): server ≤ 50 ms p95 (PERF-B18), ≤ 2 statements
//   ING-22 signed call request: server ≤ 250 ms p95 and within its statement budget. Runs only when
//          PERF_INGEST_KEY_ID and PERF_INGEST_SECRET name a key for a client allowed on call-requests; skipped otherwise.
//   Also reports the P2 read routes (triage counts, reporting, companies, people) against their statement budgets.
//
// Signs in with the demo account and touches only ideas it creates, titled "[perf-p2] ...", which it deletes at the
// end (also on failure). Intake ideas it sends carry the same prefix and are found by title search, then deleted.
// Their receipts stay (ING-15), so each run uses fresh request keys. It never loads the synthetic fixture.
import { createHash, createHmac } from 'node:crypto';

export {};

const base = process.argv[2]?.replace(/\/$/, '');
if (!base?.startsWith('https://')) { console.error('usage: pnpm perf:p2 https://host'); process.exit(1); }

const RUNS = Number(process.env.PERF_RUNS ?? 30);
const PREFIX = '[perf-p2]';
const timing = (h: Headers, name: string) => Number(new RegExp(`${name};dur=([\\d.]+)`).exec(h.get('server-timing') ?? '')?.[1] ?? NaN);
const serverMs = (h: Headers) => ['auth', 'db', 'pool', 'app'].reduce((n, k) => n + (timing(h, k) || 0), 0);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
const results: { id: string; pass: boolean | null; detail: string }[] = [];
const record = (id: string, pass: boolean | null, detail: string) => {
  results.push({ id, pass, detail });
  console.log(`${pass === null ? 'SKIP' : pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
};

let cookie = '';
const created = new Set<string>();
const headers = (json = false) => ({ cookie, Origin: base!, ...(json && { 'Content-Type': 'application/json' }) });
const spec = (s: object) => `spec=${encodeURIComponent(JSON.stringify(s))}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function timed(path: string, init?: RequestInit) {
  const t = performance.now();
  const res = await fetch(`${base}${path}`, init);
  const body = await res.text();
  return { res, ms: performance.now() - t, body, statements: Number(res.headers.get('x-statement-count')), budget: Number(res.headers.get('x-statement-budget')) };
}

async function createIdea(title: string) {
  const r = await timed('/api/fh/ideas', { method: 'POST', headers: headers(true), body: JSON.stringify({ title: `${PREFIX} ${title}` }) });
  if (r.res.status !== 201) throw new Error(`create failed: ${r.res.status} ${r.body.slice(0, 200)}`);
  const id = JSON.parse(r.body).row.id as string;
  created.add(id);
  return id;
}

async function main() {
  const demo = await fetch(`${base}/api/auth/demo`, { method: 'POST', headers: { Origin: base! } });
  cookie = demo.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!cookie) throw new Error(`demo sign-in failed (${demo.status})`);

  // PT-17: two near-identical ideas so the background job stores a match, then read it repeatedly.
  const stamp = Date.now().toString(36);
  await createIdea(`gantt export timeline pdf ${stamp}`);
  const b = await createIdea(`gantt export timeline pdf ${stamp} please`);
  let matches = 0;
  for (let i = 0; i < 20 && !matches; i++) {
    await sleep(1500); // matching runs after the create response (job drained by after(), else cron within 1 min)
    const r = await timed(`/api/fh/ideas/${b}/matches`, { headers: headers() });
    matches = JSON.parse(r.body).matches?.length ?? 0;
  }
  const mServer: number[] = [], mStmts: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await timed(`/api/fh/ideas/${b}/matches`, { headers: headers() });
    mServer.push(serverMs(r.res.headers)); mStmts.push(r.statements);
  }
  record('PT-17 duplicate match read', pct(mServer, 95) <= 50 && Math.max(...mStmts) <= 2,
    `server p95 ${pct(mServer, 95).toFixed(1)} ms (≤ 50), statements ${Math.max(...mStmts)} (≤ 2), ${matches} stored match(es)${matches ? '' : ' (matching job not drained yet; read cost measured anyway)'}`);

  // P2 read routes: statement budgets on live data.
  const reads: [string, string][] = [
    ['triage counts', `/api/fh/ideas/triage-counts?${spec({ view: 'triage' })}`],
    ['reporting', '/api/fh/reporting'],
    ['companies', '/api/fh/companies?full=1'],
    ['people', '/api/fh/people?full=1'],
  ];
  for (const [name, path] of reads) {
    const ms: number[] = [];
    let worst = 0, budget = 0;
    for (let i = 0; i < 10; i++) {
      const r = await timed(path, { headers: headers() });
      if (!r.res.ok) throw new Error(`${name} failed: ${r.res.status}`);
      ms.push(serverMs(r.res.headers)); worst = Math.max(worst, r.statements); budget = r.budget;
    }
    record(`P2 ${name}`, worst <= budget, `server p95 ${pct(ms, 95).toFixed(1)} ms, statements ${worst} (budget ${budget})`);
  }

  // ING-22: signed call requests (optional).
  const keyId = process.env.PERF_INGEST_KEY_ID, secret = process.env.PERF_INGEST_SECRET;
  if (!keyId || !secret) {
    record('ING-22 intake call request', null, 'PERF_INGEST_KEY_ID / PERF_INGEST_SECRET not set');
    return;
  }
  const path = '/api/ingest/fh/v1/call-requests';
  const iServer: number[] = [], iStmts: number[] = [];
  let budget = 0;
  const n = Math.min(RUNS, 20); // stays inside the default 60-per-minute client limit
  for (let i = 0; i < n; i++) {
    const requestKey = `perf-p2:${stamp}:${i}`;
    const body = JSON.stringify({
      type: 'feature_request', title: `${PREFIX} intake ${stamp} ${i}`, details: null, quote: 'Synthetic timing request', quoteVerified: true,
      requester: null, company: null,
      call: { transcriptId: `perf-${stamp}`, title: 'Timing run', date: null, type: 'feedback_session', timeInCall: '0:00:01', link: null },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const canonical = ['1', ts, requestKey, 'POST', path, createHash('sha256').update(body).digest('hex')].join('\n');
    const signature = createHmac('sha256', Buffer.from(secret, 'utf8')).update(canonical).digest('hex');
    const t = performance.now();
    const res = await fetch(`${base}${path}`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-ingest-version': '1', 'x-ingest-key': keyId, 'x-ingest-timestamp': ts, 'x-ingest-request-key': requestKey, 'x-ingest-signature': signature },
    });
    await res.text();
    if (res.status !== 202) throw new Error(`intake answered ${res.status}`);
    iServer.push(performance.now() - t); // the gateway sends no Server-Timing; this is observed time, an upper bound
    iStmts.push(Number(res.headers.get('x-statement-count')));
    budget = Number(res.headers.get('x-statement-budget'));
  }
  record('ING-22 intake call request', pct(iServer, 95) <= 250 && Math.max(...iStmts) <= budget,
    `observed p95 ${pct(iServer, 95).toFixed(0)} ms (≤ 250 server; observed includes network), statements ${Math.max(...iStmts)} (budget ${budget})`);
  const found = await timed(`/api/fh/ideas?${spec({ view: 'all', search: `${PREFIX} intake ${stamp}` })}`, { headers: headers() });
  for (const r of JSON.parse(found.body).rows ?? []) created.add(r.id);
}

async function cleanup() {
  const ids = [...created];
  for (let i = 0; i < ids.length; i += 200) {
    await fetch(`${base}/api/fh/ideas/delete`, { method: 'POST', headers: headers(true), body: JSON.stringify({ ids: ids.slice(i, i + 200) }) }).catch(() => {});
  }
  if (ids.length) console.log(`cleaned up ${ids.length} ${PREFIX} ideas`);
}

main()
  .catch((e) => { console.error(String(e)); results.push({ id: 'run', pass: false, detail: String(e) }); })
  .finally(async () => {
    await cleanup();
    const failed = results.filter((r) => r.pass === false).length;
    console.log(`\n${results.filter((r) => r.pass).length} passed, ${failed} failed, ${results.filter((r) => r.pass === null).length} skipped`);
    process.exit(failed ? 1 : 0);
  });
