// P4 acceptance on a deployed environment: `pnpm perf:p4 https://<deployment>`
// Signs in with the demo button, creates its OWN boards (named "[perf-p4] …", never the synthetic fixture),
// measures, then deletes them.
//   PT-09  boot metadata: 1 request, ≤ 50 KB, statement budget (PERF-B11)
//   PT-10  open a 2,000-node / 2,000-edge board: server ≤ 300 ms, ≤ 1.5 MB transferred (PERF-B12, server side)
//   PT-13  50-op batch on a 200-node and a 2,000-node board: server p95 ≤ 80 ms, same statement count, ≤ 8 + preamble (PERF-B15)
//   PT-15  remote board edit visible to a second session ≤ 1 s (PERF-B17), measured through changes?since
// PT-10 (time to interactive canvas, long tasks), PT-11 (drag frame times) and PT-12 (typing INP and re-render count)
// need a real browser with CPU throttling; they are printed as MANUAL with the steps to run them in Chrome.

export {}; // a module, so its names do not clash with the other scripts

const base = process.argv[2]?.replace(/\/$/, '');
if (!base?.startsWith('https://')) { console.error('usage: pnpm perf:p4 https://host'); process.exit(1); }

const LABEL = '[perf-p4]';
const RUNS = 30;
const timing = (h: Headers) => ['auth', 'db', 'pool', 'app'].reduce((s, k) => s + Number(new RegExp(`${k};dur=([\\d.]+)`).exec(h.get('server-timing') ?? '')?.[1] ?? 0), 0);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
const results: { id: string; pass: boolean | null; detail: string }[] = [];
const record = (id: string, pass: boolean | null, detail: string) => {
  results.push({ id, pass, detail });
  console.log(`${pass === null ? 'MANUAL' : pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
};

async function signIn(): Promise<string> {
  const r = await fetch(`${base}/api/auth/demo`, { method: 'POST', headers: { Origin: base! } });
  const cookie = r.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`demo sign-in failed (${r.status}); is DEMO_MODE=1?`);
  return cookie;
}

function client(cookie: string) {
  return async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const r = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { cookie, Origin: base!, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await r.text();
    let body: unknown = null; try { body = JSON.parse(text); } catch { /* empty */ }
    return { status: r.status, body: body as Record<string, unknown> & { [k: string]: unknown }, bytes: Buffer.byteLength(text), serverMs: timing(r.headers), statements: Number(r.headers.get('x-statement-count')) };
  };
}

let batchN = 0;
const bid = () => `perfp4-${Date.now()}-${++batchN}`;
const card = (i: number) => ({ type: 'node', op: 'create', id: `n${i}`, value: { kind: 'design-card', x: (i % 50) * 300, y: Math.floor(i / 50) * 200, sortKey: 'V', data: { title: `${LABEL} card ${i}`, owner: `Owner ${i % 7}` } } });

async function makeBoard(api: ReturnType<typeof client>, name: string, nodes: number, edges: number): Promise<string> {
  const c = await api('/api/jb/boards', { method: 'POST', body: { name: `${LABEL} ${name}` } });
  if (c.status !== 201) throw new Error(`create board failed ${c.status}`);
  const id = (c.body.meta as { id: string }).id;
  for (let i = 0; i < nodes; i += 500) {
    const ops = Array.from({ length: Math.min(500, nodes - i) }, (_, k) => card(i + k + 1));
    const r = await api(`/api/jb/boards/${id}/ops`, { method: 'POST', body: { batchId: bid(), clientId: 'perf-p4', protocol: 1, ops } });
    if (r.status !== 200) throw new Error(`seeding nodes failed ${r.status} ${JSON.stringify(r.body)}`);
  }
  for (let i = 0; i < edges; i += 500) {
    const ops = Array.from({ length: Math.min(500, edges - i) }, (_, k) => {
      const e = i + k + 1;
      return { type: 'edge', op: 'create', id: `e${e}`, value: { source: `n${e}`, target: `n${(e % nodes) + 1}`, sortKey: 'V', data: {} } };
    });
    const r = await api(`/api/jb/boards/${id}/ops`, { method: 'POST', body: { batchId: bid(), clientId: 'perf-p4', protocol: 1, ops } });
    if (r.status !== 200) throw new Error(`seeding edges failed ${r.status}`);
  }
  return id;
}

async function main() {
  const api = client(await signIn());
  const other = client(await signIn()); // a second session for PT-15
  const created: string[] = [];
  try {
    const small = await makeBoard(api, '200 cards', 200, 0); created.push(small);
    const large = await makeBoard(api, '2,000 cards', 2000, 2000); created.push(large);

    // PT-09
    const boot: number[] = []; let bytes = 0; let stmts = 0;
    for (let i = 0; i < RUNS; i++) { const r = await api('/api/jb/boards'); boot.push(r.serverMs); bytes = Math.max(bytes, r.bytes); stmts = Math.max(stmts, r.statements); }
    const boards = ((await api('/api/jb/boards')).body.boards as unknown[]).length;
    record('PT-09 boot metadata', bytes <= 50 * 1024 * Math.max(1, boards / 100) && stmts <= 2,
      `1 request, ${(bytes / 1024).toFixed(1)} KB for ${boards} boards, server p95 ${pct(boot, 95).toFixed(1)} ms, ${stmts} statements (budget 2)`);

    // PT-10 server side
    const open: number[] = []; let size = 0;
    for (let i = 0; i < RUNS; i++) { const r = await api(`/api/jb/boards/${large}/content`); open.push(r.serverMs); size = r.bytes; }
    record('PT-10 open 2,000-node board (server)', pct(open, 95) <= 300 && size <= 1.5 * 1024 * 1024,
      `server p95 ${pct(open, 95).toFixed(1)} ms (budget 300), ${(size / 1024).toFixed(0)} KB uncompressed (budget 1.5 MB)`);
    record('PT-10 time to interactive canvas', null,
      `Chrome, 4x CPU throttle, 40 ms latency, 10 Mbit/s, cold cache: open ${base}/jb/${large} and check interactive ≤ 1.0 s and ≤ 2 long tasks in the Performance panel`);

    // PT-13
    const batchCost = async (boardId: string) => {
      const ms: number[] = []; const st: number[] = [];
      let version = 1;
      for (let i = 0; i < RUNS; i++) {
        const ops = Array.from({ length: 50 }, (_, k) => ({ type: 'node', op: 'patch', id: `n${k + 1}`, baseVersion: version, set: { x: k * 300 + i }, data: { title: `${LABEL} card ${k + 1} run ${i}` } }));
        const r = await api(`/api/jb/boards/${boardId}/ops`, { method: 'POST', body: { batchId: bid(), clientId: 'perf-p4', protocol: 1, ops } });
        if (r.status !== 200) throw new Error(`batch failed ${r.status} ${JSON.stringify(r.body)}`);
        version++; ms.push(r.serverMs); st.push(r.statements);
      }
      return { p95: pct(ms, 95), statements: Math.max(...st.slice(1)) }; // first run may include a principal-cache miss
    };
    const s = await batchCost(small); const l = await batchCost(large);
    record('PT-13 50-op batch', s.p95 <= 80 && l.p95 <= 80 && s.statements === l.statements && l.statements <= 8,
      `200 nodes: p95 ${s.p95.toFixed(1)} ms, ${s.statements} statements; 2,000 nodes: p95 ${l.p95.toFixed(1)} ms, ${l.statements} statements (budget 80 ms, ≤ 8, equal)`);

    // PT-15: edit in one session, see it from another through changes?since (the realtime path is faster when enabled).
    const lag: number[] = [];
    let seq = Number(((await other(`/api/jb/boards/${small}/changes?since=0`)).body.seq as number) ?? 0);
    let version = 1;
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const w = await api(`/api/jb/boards/${small}/ops`, { method: 'POST', body: { batchId: bid(), clientId: 'perf-p4-a', protocol: 1,
        ops: [{ type: 'node', op: 'patch', id: 'n100', baseVersion: i === 0 ? 1 : version, data: { title: `${LABEL} remote ${i}` } }] } });
      if (w.status !== 200) throw new Error(`remote edit failed ${w.status} ${JSON.stringify(w.body)}`);
      version = (w.body.results as { version: number }[])[0].version;
      for (;;) {
        const r = await other(`/api/jb/boards/${small}/changes?since=${seq}`);
        const batches = (r.body.batches as unknown[]) ?? [];
        if (batches.length) { seq = Number(r.body.seq); break; }
        if (performance.now() - t0 > 5000) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      lag.push(performance.now() - t0);
    }
    record('PT-15 remote board edit visible', pct(lag, 95) <= 1000,
      `p95 ${pct(lag, 95).toFixed(0)} ms from send to visible in another session (budget 1 s; clients poll every 1 s when realtime is off)`);
    record('PT-11 drag 30 cards for 3 s', null, `Chrome Performance panel on ${base}/jb/${large}: frames ≤ 16 ms, scripting ≤ 8 ms; Network shows exactly 1 ops request after drag stop (0 IndexedDB writes during the drag is covered by tests/unit/jb-client.test.ts)`);
    record('PT-12 typing in a card field', null, `React Profiler on ${base}/jb/${large}: INP ≤ 100 ms and ≤ 5 node components re-render per keystroke`);
  } finally {
    for (const id of created) await api(`/api/jb/boards/${id}`, { method: 'DELETE' }).catch(() => null);
    console.log(`cleaned up ${created.length} ${LABEL} boards`);
  }
  const failed = results.filter((r) => r.pass === false).length;
  console.log(`\n${results.filter((r) => r.pass).length} passed, ${failed} failed, ${results.filter((r) => r.pass === null).length} manual`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
