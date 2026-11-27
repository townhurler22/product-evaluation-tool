// Public forum test helpers: forums, share links and calls to the share routes the way a browser makes them.
import { NextRequest } from 'next/server';
import { call } from './http';
import { POST as createForumRoute } from '@/app/api/fh/forums/route';
import { POST as createLinkRoute } from '@/app/api/core/share-links/route';

export async function makeForum(cookie: string, name: string, extra: { main?: boolean; prompt?: string } = {}) {
  const r = await call(createForumRoute, { method: 'POST', cookie, body: { name, prompt: extra.prompt ?? null } });
  if (r.status !== 201) throw new Error(`forum create failed: ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.forum.id as string;
  if (extra.main) {
    const { PATCH } = await import('@/app/api/fh/forums/[id]/route');
    const m = await call(PATCH, { method: 'PATCH', cookie, params: { id }, body: { main: true } });
    if (m.status !== 200) throw new Error(`make main failed: ${m.status}`);
  }
  return id;
}

export async function makeLink(cookie: string, forumId: string, capabilities: string[] = ['VIEW', 'SUBMIT', 'VOTE'], extra: Record<string, unknown> = {}) {
  const r = await call(createLinkRoute, { method: 'POST', cookie, body: { module: 'fh', targetKind: 'forum', targetId: forumId, capabilities, ...extra } });
  if (r.status !== 201) throw new Error(`link create failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.link.id as string, token: (r.body.url as string).split('/').pop()! };
}

type Handler = (req: NextRequest, segment: { params: Promise<Record<string, string>> }) => Promise<Response>;

export interface ShareResult<T = any> { status: number; body: T; text: string; headers: Headers; statements: number; setCookie: string | null } // eslint-disable-line @typescript-eslint/no-explicit-any

/** Calls a share route as a visitor's browser would: same origin, IP header, optional cookie and password. */
export async function share<T = any>(handler: Handler, opts: { // eslint-disable-line @typescript-eslint/no-explicit-any
  token: string; path?: string; method?: string; params?: Record<string, string>; cookie?: string; password?: string;
  json?: unknown; form?: FormData; ip?: string;
}): Promise<ShareResult<T>> {
  const headers = new Headers({ 'x-real-ip': opts.ip ?? '198.51.100.20' });
  const method = opts.method ?? 'GET';
  if (method !== 'GET') headers.set('origin', 'http://localhost:3000');
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.password) headers.set('x-share-password', opts.password);
  let body: BodyInit | undefined;
  if (opts.json !== undefined) { headers.set('content-type', 'application/json'); body = JSON.stringify(opts.json); }
  if (opts.form) body = opts.form;
  const req = new NextRequest(new URL(opts.path ?? `/api/share/${opts.token}/fh/forum`, 'http://localhost:3000'), { method, headers, body });
  const res = await handler(req, { params: Promise.resolve({ token: opts.token, ...opts.params }) });
  const budget = res.headers.get('x-statement-budget');
  const used = Number(res.headers.get('x-statement-count') ?? 0);
  if (budget !== null && used > Number(budget)) throw new Error(`statement budget exceeded: ${used} > ${budget} for ${method} ${opts.path ?? ''}`);
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed as T, text, headers: res.headers, statements: used, setCookie: res.headers.get('set-cookie') };
}

/** A visitor post as the browser composer sends it (multipart). */
export function postForm(fields: Record<string, string>, images: { bytes: Buffer; name: string; type: string }[] = []) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  for (const i of images) f.append('images', new Blob([new Uint8Array(i.bytes)], { type: i.type }), i.name);
  return f;
}

export const visitorCookie = (setCookie: string | null) => setCookie?.split(';')[0] ?? '';
