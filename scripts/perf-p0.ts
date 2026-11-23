// P0 acceptance on a deployed environment: `pnpm perf:p0 https://<demo deployment>`
//   PT-06  API preamble ≤ 1 DB round trip and ≤ 15 ms (PERF-B08)
//   PT-07  20 concurrent requests from one client: none > 1 s, no connection timeouts (PERF-B09)
//   PT-08  cold start ≤ 800 ms (PERF-B10); measured as the first /api/healthz after a fresh deploy
//   ARC-32 database round trip ≤ 5 ms p50, from the db span of /api/readyz (one statement)
// Needs the demo deployment (DEMO_MODE=1) so it can sign in without an email.

const base = process.argv[2]?.replace(/\/$/, '');
if (!base?.startsWith('https://')) { console.error('usage: pnpm perf:p0 https://host'); process.exit(1); }

const timing = (h: Headers, name: string) => Number(new RegExp(`${name};dur=([\\d.]+)`).exec(h.get('server-timing') ?? '')?.[1] ?? NaN);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
const results: { id: string; pass: boolean; detail: string }[] = [];
const record = (id: string, pass: boolean, detail: string) => { results.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };

async function main() {
  // PT-08: first request after deploy. Run this script straight after a deploy for a true cold start.
  const c0 = performance.now();
  const cold = await fetch(`${base}/api/healthz`);
  const coldMs = performance.now() - c0;
  record('PT-08 cold start (client-observed, includes network)', cold.ok && coldMs <= 800 + 150, `${coldMs.toFixed(0)} ms (budget 800 ms + ~150 ms network allowance)`);

  const demo = await fetch(`${base}/api/auth/demo`, { method: 'POST', headers: { Origin: base } });
  const cookie = demo.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`demo sign-in failed (${demo.status}); is DEMO_MODE=1 and the demo seed loaded?`);

  // ARC-32: 30 readyz calls; db span = one statement's round trip.
  const rtt: number[] = [];
  for (let i = 0; i < 30; i++) rtt.push(timing((await fetch(`${base}/api/readyz`)).headers, 'db'));
  record('ARC-32 DB round trip p50', pct(rtt, 50) <= 5, `p50 ${pct(rtt, 50).toFixed(1)} ms, p95 ${pct(rtt, 95).toFixed(1)} ms`);

  // PT-06: preamble cost on an authenticated route.
  const pre: number[] = []; const stmts: number[] = [];
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${base}/api/me`, { headers: { cookie } });
    pre.push(timing(r.headers, 'auth') + timing(r.headers, 'db') + timing(r.headers, 'pool'));
    stmts.push(Number(r.headers.get('x-statement-count')));
  }
  record('PT-06 preamble', Math.max(...stmts) <= 1 && pct(pre, 95) <= 15,
    `p95 ${pct(pre, 95).toFixed(1)} ms; max statements ${Math.max(...stmts)} (budget 1)`);

  // PT-07: 20 concurrent from one client, 5 rounds.
  const lat: number[] = []; const statuses: number[] = [];
  for (let round = 0; round < 5; round++) {
    await Promise.all(Array.from({ length: 20 }, async (_, i) => {
      const t = performance.now();
      const r = await fetch(`${base}/api/${i % 2 ? 'me' : 'readyz'}`, { headers: { cookie } });
      lat.push(performance.now() - t); statuses.push(r.status);
    }));
  }
  const bad = statuses.filter((s) => s >= 500).length;
  record('PT-07 20 concurrent', Math.max(...lat) <= 1000 && bad === 0, `max ${Math.max(...lat).toFixed(0)} ms, p95 ${pct(lat, 95).toFixed(0)} ms, 5xx ${bad}`);

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
