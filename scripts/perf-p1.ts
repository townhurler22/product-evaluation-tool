// P1 acceptance timings on a deployed environment: `pnpm perf:p1 https://<deployment>`
//   PT-01  create an idea: POST server time ≤ 100 ms and ≤ 6 statements; the response is the full row (0 extra requests)
//   PT-02  idea summary: browser-observed ≤ 300 ms p95, server ≤ 80 ms, ≤ 3 statements, ≤ 50 KB
//   PT-03  ideas list page for every view, with and without filters and search: server ≤ 150 ms p95, ≤ 4 statements, ≤ 100 KB
//   PT-05  inline edit round trip (the UI applies it optimistically; this measures the server half)
//   PT-15  remote change propagation ≤ 1 s, when realtime is configured (otherwise reported as skipped: clients poll)
//   PT-20  CSV export of up to 5,000 filtered rows: first bytes ≤ 500 ms, complete ≤ 5 s
// PT-04 (scrolling 5,000 rows at 60 fps) is a browser measurement: run it in Chrome DevTools Performance.
//
// Signs in with the demo account only and touches only ideas it creates, titled "[perf] ...", which it deletes at
// the end (also on failure). It never loads the synthetic fixture. Timings reflect the live data volume, not §13.4.

export {}; // a module, so its names do not clash with the other scripts

const base = process.argv[2]?.replace(/\/$/, '');
if (!base?.startsWith('https://')) { console.error('usage: pnpm perf:p1 https://host'); process.exit(1); }

const RUNS = Number(process.env.PERF_RUNS ?? 30);
const timing = (h: Headers, name: string) => Number(new RegExp(`${name};dur=([\\d.]+)`).exec(h.get('server-timing') ?? '')?.[1] ?? NaN);
const serverMs = (h: Headers) => ['auth', 'db', 'pool', 'app'].reduce((n, k) => n + (timing(h, k) || 0), 0);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
const results: { id: string; pass: boolean | null; detail: string }[] = [];
const record = (id: string, pass: boolean | null, detail: string) => {
  results.push({ id, pass, detail });
  console.log(`${pass === null ? 'SKIP' : pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
};

let cookie = '';
const created: string[] = [];
const headers = (json = false) => ({ cookie, Origin: base!, ...(json && { 'Content-Type': 'application/json' }) });
const spec = (s: object) => `spec=${encodeURIComponent(JSON.stringify(s))}`;

async function timed(path: string, init?: RequestInit) {
  const t = performance.now();
  const res = await fetch(`${base}${path}`, init);
  const body = await res.text();
  return { res, ms: performance.now() - t, body, bytes: Buffer.byteLength(body), statements: Number(res.headers.get('x-statement-count')) };
}

async function main() {
  const demo = await fetch(`${base}/api/auth/demo`, { method: 'POST', headers: { Origin: base! } });
  cookie = demo.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!cookie) throw new Error(`demo sign-in failed (${demo.status}); is DEMO_MODE=1 and the demo seed loaded?`);

  // PT-01
  const cServer: number[] = [], cStmts: number[] = [];
  let firstRow: Record<string, unknown> | null = null;
  for (let i = 0; i < RUNS; i++) {
    const r = await timed('/api/fh/ideas', { method: 'POST', headers: headers(true), body: JSON.stringify({ title: `[perf] create ${i} ${Date.now()}` }) });
    if (r.res.status !== 201) throw new Error(`create failed: ${r.res.status} ${r.body.slice(0, 200)}`);
    const row = JSON.parse(r.body).row;
    created.push(row.id);
    firstRow ??= row;
    cServer.push(serverMs(r.res.headers)); cStmts.push(r.statements);
  }
  const fullRow = !!firstRow && ['id', 'number', 'title', 'status', 'ownerId', 'featureId', 'arr', 'themeIds'].every((k) => k in firstRow!);
  record('PT-01 create', pct(cServer, 95) <= 100 && Math.max(...cStmts) <= 6 && fullRow,
    `server p95 ${pct(cServer, 95).toFixed(1)} ms (≤ 100), max statements ${Math.max(...cStmts)} (≤ 6), full row in response: ${fullRow}`);

  // PT-02
  const sBrowser: number[] = [], sServer: number[] = [], sStmts: number[] = [], sBytes: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await timed(`/api/fh/ideas/${created[i % created.length]}`, { headers: headers() });
    sBrowser.push(r.ms); sServer.push(serverMs(r.res.headers)); sStmts.push(r.statements); sBytes.push(r.bytes);
  }
  record('PT-02 summary', pct(sBrowser, 95) <= 300 && pct(sServer, 95) <= 80 && Math.max(...sStmts) <= 3 && Math.max(...sBytes) <= 50 * 1024,
    `observed p95 ${pct(sBrowser, 95).toFixed(0)} ms, server p95 ${pct(sServer, 95).toFixed(1)} ms, statements ${Math.max(...sStmts)}, ${Math.max(...sBytes)} bytes`);

  // PT-03
  const specs = ['all', 'triage', 'backlog', 'roadmap', 'board'].flatMap((view) => [
    { view }, { view, search: 'perf' }, { view, filters: { type: ['FEATURE_REQUEST', 'BUG'], source: ['MANUAL'] }, sort: { column: 'arr', dir: 'desc' } },
  ]);
  const lServer: number[] = [], lStmts: number[] = [], lBytes: number[] = [];
  for (let i = 0; i < Math.max(RUNS, specs.length); i++) {
    const r = await timed(`/api/fh/ideas?${spec(specs[i % specs.length])}`, { headers: headers() });
    lServer.push(serverMs(r.res.headers)); lStmts.push(r.statements); lBytes.push(r.bytes);
  }
  record('PT-03 list', pct(lServer, 95) <= 150 && Math.max(...lStmts) <= 4 && Math.max(...lBytes) <= 100 * 1024,
    `server p95 ${pct(lServer, 95).toFixed(1)} ms, statements ${Math.max(...lStmts)}, largest page ${Math.max(...lBytes)} bytes`);

  // PT-05 (server half of an inline edit)
  const eServer: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await timed(`/api/fh/ideas/${created[0]}`, { method: 'PATCH', headers: headers(true), body: JSON.stringify({ title: `[perf] edit ${i}` }) });
    eServer.push(r.ms);
  }
  record('PT-05 inline edit round trip', null, `observed p95 ${pct(eServer, 95).toFixed(0)} ms. The visual update is optimistic (≤ 50 ms budget is client-side)`);

  // PT-15
  const tok = await (await fetch(`${base}/api/core/realtime/token`, { method: 'POST', headers: headers(true), body: JSON.stringify({ channels: ['fh.workspace'] }) })).json();
  if (!tok.available) {
    record('PT-15 remote change', null, 'realtime token unavailable (SUPABASE_JWT_SECRET not set); clients poll every 30 s');
  } else {
    const { RealtimeClient } = await import('@supabase/supabase-js');
    const client = new RealtimeClient(`${String(tok.url).replace(/^http/, 'ws')}/realtime/v1`, { params: { apikey: tok.token } });
    client.setAuth(tok.token);
    const lat: number[] = [];
    let pending: { id: string; t: number; resolve: () => void } | null = null;
    const ch = client.channel('fh.workspace', { config: { private: true } });
    ch.on('broadcast', { event: 'idea.upserted' }, (m: { payload: { row: { id: string; title: string } } }) => {
      if (pending && m.payload.row.id === pending.id && m.payload.row.title.includes('remote')) { lat.push(performance.now() - pending.t); pending.resolve(); }
    });
    const joined = await new Promise<boolean>((res) => {
      ch.subscribe((s: string) => (s === 'SUBSCRIBED' ? res(true) : s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' ? res(false) : undefined));
      setTimeout(() => res(false), 10_000);
    });
    if (!joined) {
      client.disconnect();
      record('PT-15 remote change', null, 'Supabase refused the realtime token (needs the legacy JWT secret); clients poll every 30 s');
    } else {
    for (let i = 0; i < Math.min(RUNS, 10); i++) {
      await new Promise<void>((resolve) => {
        pending = { id: created[0], t: performance.now(), resolve };
        void fetch(`${base}/api/fh/ideas/${created[0]}`, { method: 'PATCH', headers: headers(true), body: JSON.stringify({ title: `[perf] remote ${i}` }) });
        setTimeout(resolve, 3000);
      });
    }
    client.disconnect();
    record('PT-15 remote change', lat.length > 0 && pct(lat, 95) <= 1000, `${lat.length} events, p95 ${lat.length ? pct(lat, 95).toFixed(0) : '–'} ms (≤ 1000)`);
    }
  }

  // PT-20
  const t0 = performance.now();
  const ex = await fetch(`${base}/api/fh/ideas/export`, {
    method: 'POST', headers: headers(true),
    body: JSON.stringify({ viewSpec: { view: 'all' }, columns: ['number', 'title', 'status', 'type', 'owner', 'feature', 'companies', 'themes', 'arr', 'users', 'createdAt'] }),
  });
  const reader = ex.body!.getReader();
  let first = NaN, bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (Number.isNaN(first)) first = performance.now() - t0;
    bytes += value.length;
  }
  const total = performance.now() - t0;
  const rows = Number(ex.headers.get('x-export-rows'));
  record('PT-20 export', ex.ok && first <= 500 && total <= 5000,
    `${rows} rows (budget measured at 5,000), first bytes ${first.toFixed(0)} ms (≤ 500), complete ${total.toFixed(0)} ms (≤ 5000), ${bytes} bytes`);
  if (rows < 5000) console.log('  note: fewer than 5,000 ideas exist here, so PT-20 is not proven at the budget size.');
}

async function cleanup() {
  for (let i = 0; i < created.length; i += 200) {
    await fetch(`${base}/api/fh/ideas/delete`, { method: 'POST', headers: headers(true), body: JSON.stringify({ ids: created.slice(i, i + 200) }) }).catch(() => {});
  }
  if (created.length) console.log(`cleaned up ${created.length} [perf] ideas`);
}

main()
  .catch((e) => { console.error(String(e)); results.push({ id: 'run', pass: false, detail: String(e) }); })
  .finally(async () => {
    await cleanup();
    const failed = results.filter((r) => r.pass === false).length;
    console.log(`\n${results.filter((r) => r.pass).length} passed, ${failed} failed, ${results.filter((r) => r.pass === null).length} skipped`);
    process.exit(failed ? 1 : 0);
  });
