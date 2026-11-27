// P5 acceptance on a deployed environment: `pnpm perf:p5 https://<deployment>`
// Signs in with the demo button and builds its OWN self-labelled data ("[perf-p5] …": Features, ideas, boards,
// detailed journeys, links), never the synthetic fixture. Everything it created is deleted afterwards.
//   PT-14  demand overlay on a top-level board with 40 Product cards, each with a 50-card detailed journey:
//          1 request, server p95 ≤ 150 ms, ≤ 4 statements, same statement count as on a 2-card board (PERF-B16)
//   PT-18  Journey sync of a card with a 50-card journey: server p95 ≤ 500 ms, same statement count before and after
//          10 more boards are added to the workspace (PERF-B19)
//   D-27   a deleted linked Feature surfaces on the board's 1 s changes poll and as an overlay attention flag ≤ 1 s

export {}; // a module, so its names do not clash with the other scripts

const base = process.argv[2]?.replace(/\/$/, '');
if (!base?.startsWith('https://')) { console.error('usage: pnpm perf:p5 https://host'); process.exit(1); }

const LABEL = '[perf-p5]';
const RUNS = 30;
const timing = (h: Headers) => ['auth', 'db', 'pool', 'app'].reduce((s, k) => s + Number(new RegExp(`${k};dur=([\\d.]+)`).exec(h.get('server-timing') ?? '')?.[1] ?? 0), 0);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
const results: { id: string; pass: boolean }[] = [];
const record = (id: string, pass: boolean, detail: string) => { results.push({ id, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };

async function signIn(): Promise<string> {
  const r = await fetch(`${base}/api/auth/demo`, { method: 'POST', headers: { Origin: base! } });
  const cookie = r.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`demo sign-in failed (${r.status}); is DEMO_MODE=1?`);
  return cookie;
}

type Res = { status: number; body: Record<string, unknown> & { [k: string]: unknown }; serverMs: number; statements: number };
function client(cookie: string) {
  return async (path: string, init: { method?: string; body?: unknown } = {}): Promise<Res> => {
    const r = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { cookie, Origin: base!, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await r.text();
    let body: unknown = null; try { body = JSON.parse(text); } catch { /* empty */ }
    return { status: r.status, body: body as Res['body'], serverMs: timing(r.headers), statements: Number(r.headers.get('x-statement-count')) };
  };
}

let n = 0;
const bid = () => `perfp5-${Date.now()}-${++n}`;
const must = (r: Res, what: string, status = 200) => { if (r.status !== status) throw new Error(`${what} failed ${r.status} ${JSON.stringify(r.body)}`); return r; };

async function main() {
  const api = client(await signIn());
  const boards: string[] = []; const features: string[] = []; const ideas: string[] = []; const journeys = new Set<string>();
  const ops = (board: string, list: unknown[]) => api(`/api/jb/boards/${board}/ops`, { method: 'POST', body: { batchId: bid(), clientId: 'perf-p5', protocol: 1, ops: list } });
  const product = (id: string, title: string, x = 0) => ({ type: 'node', op: 'create', id, value: { kind: 'product-card', x, y: -300, sortKey: 'V', data: { title } } });
  const design = (i: number) => ({ type: 'node', op: 'create', id: `n${i}`, value: { kind: 'design-card', x: (i % 10) * 300, y: Math.floor(i / 10) * 200, sortKey: 'V', data: { title: `${LABEL} step ${i}` } } });

  async function topBoard(name: string, cards: number, journeyCards: number, featureIds: string[]) {
    const id = (must(await api('/api/jb/boards', { method: 'POST', body: { name: `${LABEL} ${name}` } }), 'create board', 201).body.meta as { id: string }).id;
    boards.push(id);
    must(await ops(id, Array.from({ length: cards }, (_, k) => product(`p${k + 1}`, `${LABEL} product ${k + 1}`, k * 300))), 'product cards');
    for (let k = 1; k <= cards; k++) {
      const j = (must(await api('/api/jb/boards', { method: 'POST', body: { name: `${LABEL} product ${k}: detailed journey`, journeyOf: { boardId: id, nodeId: `p${k}` } } }), 'journey', 201).body.meta as { id: string }).id;
      must(await ops(j, [...Array.from({ length: journeyCards - 3 }, (_, i) => design(i + 1)), product('q1', 'Step A'), product('q2', 'Step B'), product('q3', 'Step C')]), 'journey cards');
      for (const [q, f] of [['q1', featureIds[0]], ['q2', featureIds[1]], ['q3', featureIds[k % featureIds.length]]]) {
        must(await api(`/api/jb/boards/${j}/nodes/${q}/links`, { method: 'POST', body: { featureId: f } }), 'link');
      }
    }
    return id;
  }

  try {
    // Self-labelled Feedback Hub data: two Features (one a sub-feature) with a few ideas.
    const f1 = (must(await api('/api/fh/features', { method: 'POST', body: { name: `${LABEL} Feature ${Date.now()}` } }), 'feature', 201).body.feature as { id: string }).id;
    features.push(f1);
    const f2 = (must(await api('/api/fh/features', { method: 'POST', body: { name: `${LABEL} sub-feature`, parentId: f1 } }), 'feature', 201).body.feature as { id: string }).id;
    for (let i = 0; i < 6; i++) {
      const r = must(await api('/api/fh/ideas', { method: 'POST', body: { title: `${LABEL} idea ${i}`, featureId: i % 2 ? f1 : f2 } }), 'idea', 201);
      ideas.push((r.body.row as { id: string }).id);
    }

    console.log('building the 40 × 50 demand board (a few minutes)…');
    const big = await topBoard('demand board', 40, 50, [f1, f2]);
    const small = await topBoard('2-card board', 2, 5, [f1, f2]);

    // PT-14
    const times: number[] = []; let stmts = 0;
    for (let i = 0; i < RUNS; i++) { const r = must(await api(`/api/jb/boards/${big}/overlay?scope=open`), 'overlay'); times.push(r.serverMs); stmts = Math.max(stmts, r.statements); }
    const smallStmts = (await api(`/api/jb/boards/${small}/overlay?scope=open`)).statements;
    record('PT-14', pct(times, 95) <= 150 && stmts <= 4 && stmts === smallStmts,
      `p95 ${pct(times, 95).toFixed(1)} ms, ${stmts} statements on 40 cards, ${smallStmts} on 2 cards`);

    // PT-18
    const syncT: number[] = []; let syncS = 0;
    for (let i = 0; i < RUNS; i++) {
      const r = must(await api(`/api/jb/boards/${big}/nodes/p1/journey-sync`, { method: 'POST' }), 'sync');
      journeys.add((r.body.journey as { id: string }).id); syncT.push(r.serverMs); syncS = Math.max(syncS, r.statements);
    }
    for (let i = 0; i < 10; i++) boards.push((must(await api('/api/jb/boards', { method: 'POST', body: { name: `${LABEL} extra ${i}` } }), 'extra board', 201).body.meta as { id: string }).id);
    const after = must(await api(`/api/jb/boards/${big}/nodes/p1/journey-sync`, { method: 'POST' }), 'sync');
    record('PT-18', pct(syncT, 95) <= 500 && after.statements === syncS,
      `p95 ${pct(syncT, 95).toFixed(1)} ms, ${syncS} statements; ${after.statements} after 10 more boards`);

    // D-27: delete the sub-feature; the journey board's changes poll moves and the overlay flags the card.
    const journeyOfP1 = ((await api(`/api/jb/boards/${big}/nodes/p1/demand`)).body.journeyBoardId) as string;
    const rev0 = Number((await api(`/api/jb/boards/${journeyOfP1}/changes?since=0`)).body.demandRev);
    const t0 = performance.now();
    must(await api(`/api/fh/features/${f2}`, { method: 'DELETE' }), 'delete feature');
    let flagged = false;
    while (performance.now() - t0 < 5000) {
      const rev = Number((await api(`/api/jb/boards/${journeyOfP1}/changes?since=0`)).body.demandRev);
      if (rev > rev0) {
        const o = await api(`/api/jb/boards/${journeyOfP1}/overlay?scope=open`);
        flagged = Boolean((o.body.attention as Record<string, unknown>)?.q2);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const ms = performance.now() - t0;
    record('D-27', flagged && ms <= 1000, `attention flag visible ${flagged ? `after ${ms.toFixed(0)} ms` : 'never (5 s)'} including the client round trips`);
  } finally {
    // Clean up everything this run created (boards cascade to their journeys; links stay as in production, INT-26).
    for (const id of boards) await api(`/api/jb/boards/${id}`, { method: 'DELETE' }).catch(() => null);
    for (const id of journeys) await api(`/api/fh/journeys/${id}`, { method: 'DELETE' }).catch(() => null);
    if (ideas.length) await api('/api/fh/ideas/delete', { method: 'POST', body: { ids: ideas } }).catch(() => null);
    for (const id of features) await api(`/api/fh/features/${id}`, { method: 'DELETE' }).catch(() => null);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(failed.length ? `${failed.length} check(s) failed` : 'all P5 checks passed');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
