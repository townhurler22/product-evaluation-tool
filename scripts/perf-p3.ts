// P3 acceptance timings on a deployed environment: `pnpm perf:p3 https://<deployment>`
//   PT-19  public forum page (PERF-B20): server ≤ 300 ms p95, ≤ 3 statements and ≤ 150 KB for each read the page
//          makes (forum, posts in every sort, roadmap). Also reports votes against their statement budget.
//
// Signs in with the demo account, creates a forum named "[perf-p3] <stamp>" with a share link, submits a few posts
// through the link as an anonymous visitor named "[perf-p3] visitor", measures, then cleans up: erases that visitor,
// deletes the ideas the posts created, deletes the posts when the account holds the post-delete grant, revokes the
// link and archives the forum (there is no forum delete). It never loads the synthetic fixture. Statement counts at
// fixture scale (300 posts, 20,000 votes, and 10x) are proven on PGlite by tests/integration/fh-forum-share.test.ts.
export {};

const base = process.argv[2]?.replace(/\/$/, '');
if (!base?.startsWith('https://') && !base?.startsWith('http://localhost')) { console.error('usage: pnpm perf:p3 https://host'); process.exit(1); }

const RUNS = Number(process.env.PERF_RUNS ?? 30);
const POSTS = Math.min(15, Number(process.env.PERF_POSTS ?? 10)); // stays inside 30 submits per hour per IP (SEC-27)
const PREFIX = '[perf-p3]';
const timing = (h: Headers, name: string) => Number(new RegExp(`${name};dur=([\\d.]+)`).exec(h.get('server-timing') ?? '')?.[1] ?? NaN);
const serverMs = (h: Headers) => ['auth', 'db', 'pool', 'app'].reduce((n, k) => n + (timing(h, k) || 0), 0);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
const results: { id: string; pass: boolean | null; detail: string }[] = [];
const record = (id: string, pass: boolean | null, detail: string) => {
  results.push({ id, pass, detail });
  console.log(`${pass === null ? 'SKIP' : pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
};

let cookie = '';
let visitor = '';
let forumId: string | null = null;
let linkId: string | null = null;
let canDeletePosts = false;
const postIds: string[] = [];
const staff = (json = false) => ({ cookie, Origin: base!, ...(json && { 'Content-Type': 'application/json' }) });

async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: T }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(`${base}${path}`, { method: init?.method ?? 'GET', headers: staff(init?.body !== undefined), body: init?.body !== undefined ? JSON.stringify(init.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) as T };
}

async function main() {
  const demo = await fetch(`${base}/api/auth/demo`, { method: 'POST', headers: { Origin: base! } });
  cookie = demo.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!cookie) throw new Error(`demo sign-in failed (${demo.status})`);
  const me = await api<{ isFeedbackAdmin?: boolean; canDeletePosts?: boolean }>('/api/me');
  if (!me.body.isFeedbackAdmin) {
    record('PT-19 public forum page', null, 'the demo account is not a feedback admin here, so it cannot create a forum or a share link');
    return;
  }
  canDeletePosts = !!me.body.canDeletePosts;

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const forum = await api<{ forum?: { id: string } }>('/api/fh/forums', { method: 'POST', body: { name: `${PREFIX} ${stamp}`, prompt: 'Timing run. Safe to ignore.' } });
  if (forum.status === 403) { record('PT-19 public forum page', null, 'creating a forum was refused (403) for the demo account'); return; }
  if (forum.status !== 201 || !forum.body.forum) throw new Error(`forum create failed: ${forum.status}`);
  forumId = forum.body.forum.id;
  const link = await api<{ link: { id: string }; url: string }>('/api/core/share-links', {
    method: 'POST', body: { module: 'fh', targetKind: 'forum', targetId: forumId, capabilities: ['VIEW', 'SUBMIT', 'VOTE'] },
  });
  if (link.status === 403 || link.status === 404) { record('PT-19 public forum page', null, `creating a share link was refused (${link.status})`); return; }
  if (link.status !== 201) throw new Error(`link create failed: ${link.status}`);
  linkId = link.body.link.id;
  const token = link.body.url.split('/').pop()!;
  const share = `${base}/api/share/${token}/fh`;
  const visitorHeaders = (): Record<string, string> => ({ Origin: base!, ...(visitor && { cookie: visitor }) });

  // Posts as an anonymous visitor. One identity: its name finds it again for erasure.
  for (let i = 0; i < POSTS; i++) {
    const f = new FormData();
    f.set('title', `${PREFIX} timing post ${i + 1} ${stamp}`);
    f.set('details', 'Synthetic post for a timing run. It is removed afterwards.');
    f.set('displayName', `${PREFIX} visitor`);
    const res = await fetch(`${share}/posts`, { method: 'POST', headers: visitorHeaders(), body: f });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 201) throw new Error(`submit failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    visitor = visitor || (res.headers.get('set-cookie')?.split(';')[0] ?? '');
    postIds.push(body.post.id);
  }

  const now = Date.now();
  const reads: [string, string][] = [
    ['forum', `${share}/forum`],
    ['posts trending', `${share}/forum/posts?sort=trending&now=${now}`],
    ['posts top', `${share}/forum/posts?sort=top&now=${now}`],
    ['posts new', `${share}/forum/posts?sort=new&now=${now}`],
    ['posts complete', `${share}/forum/posts?sort=complete&now=${now}`],
    ['roadmap', `${share}/forum/roadmap`],
  ];
  let allPass = true;
  const lines: string[] = [];
  for (const [name, url] of reads) {
    const ms: number[] = [];
    let stmts = 0, bytes = 0;
    for (let i = 0; i < RUNS; i++) {
      const res = await fetch(url, { headers: { cookie: visitor } });
      const text = await res.text();
      if (!res.ok) throw new Error(`${name} answered ${res.status}`);
      ms.push(serverMs(res.headers));
      stmts = Math.max(stmts, Number(res.headers.get('x-statement-count')));
      bytes = Math.max(bytes, Buffer.byteLength(text));
    }
    const ok = pct(ms, 95) <= 300 && stmts <= 3 && bytes <= 150 * 1024;
    allPass &&= ok;
    lines.push(`${name}: p95 ${pct(ms, 95).toFixed(1)} ms, ${stmts} statements, ${(bytes / 1024).toFixed(1)} KB${ok ? '' : ' (over budget)'}`);
  }
  record('PT-19 public forum page', allPass, `${lines.join('; ')} (budget ≤ 300 ms, ≤ 3 statements, ≤ 150 KB; ${POSTS} posts in this forum)`);

  // Votes: statement budget on live data (≤ 120 per hour per visitor, so a short run).
  const vMs: number[] = [];
  let vStmts = 0, vBudget = 0;
  for (let i = 0; i < Math.min(10, postIds.length); i++) {
    for (const method of ['DELETE', 'POST']) {
      const res = await fetch(`${share}/posts/${postIds[i]}/vote`, { method, headers: visitorHeaders() });
      await res.text();
      if (!res.ok) throw new Error(`vote ${method} answered ${res.status}`);
      vMs.push(serverMs(res.headers));
      vStmts = Math.max(vStmts, Number(res.headers.get('x-statement-count')));
      vBudget = Number(res.headers.get('x-statement-budget'));
    }
  }
  record('P3 vote and unvote', vStmts <= vBudget, `server p95 ${pct(vMs, 95).toFixed(1)} ms, statements ${vStmts} (budget ${vBudget})`);
}

async function cleanup() {
  const left: string[] = [];
  try {
    // The visitor identity: found by its display name, erased with SEC-20 (votes, authorship and the cookie go).
    const people = await api<{ people?: { id: string; name: string }[] }>(`/api/fh/people?full=1&q=${encodeURIComponent(PREFIX)}`);
    const ids = (people.body.people ?? []).filter((p) => p.name === `${PREFIX} visitor`).map((p) => p.id);
    if (ids.length) await api('/api/fh/people/erase', { method: 'POST', body: { ids, confirm: 'ERASE' } });
    // The ideas the posts created, by title search.
    const found = await api<{ ids?: string[] }>('/api/fh/ideas/ids', { method: 'POST', body: { viewSpec: { view: 'all', search: `${PREFIX} timing post` } } });
    const ideaIds = found.body.ids ?? [];
    if (ideaIds.length) await api('/api/fh/ideas/delete', { method: 'POST', body: { ids: ideaIds.slice(0, 200) } });
    if (forumId) {
      if (canDeletePosts) {
        for (const p of postIds) await api(`/api/fh/forums/${forumId}/posts/${p}`, { method: 'DELETE' });
      } else if (postIds.length) left.push(`${postIds.length} posts (the demo account has no post-delete grant)`);
      if (linkId) await api(`/api/core/share-links/${linkId}/revoke`, { method: 'POST' });
      await api(`/api/fh/forums/${forumId}`, { method: 'PATCH', body: { archived: true } });
      left.push('the archived forum itself (there is no forum delete)');
    }
    console.log(`cleaned up: ${ids.length} visitor erased, ${ideaIds.length} ideas deleted${left.length ? `; left in place: ${left.join(', ')}` : ''}`);
  } catch (e) {
    console.error(`cleanup incomplete: ${String(e)}`);
  }
}

main()
  .catch((e) => { console.error(String(e)); results.push({ id: 'run', pass: false, detail: String(e) }); })
  .finally(async () => {
    await cleanup();
    const failed = results.filter((r) => r.pass === false).length;
    console.log(`\n${results.filter((r) => r.pass).length} passed, ${failed} failed, ${results.filter((r) => r.pass === null).length} skipped`);
    process.exit(failed ? 1 : 0);
  });
