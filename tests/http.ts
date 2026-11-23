// Calls route handlers in-process the way Next.js would.
import { NextRequest } from 'next/server';

type Handler = (req: NextRequest, segment?: { params?: Promise<Record<string, string>> }) => Promise<Response>;

export interface CallResult<T = unknown> {
  status: number;
  body: T;
  statements: number;
  headers: Headers;
  setCookie: string | null;
}

export async function call<T = any>( // eslint-disable-line @typescript-eslint/no-explicit-any
  handler: Handler,
  opts: {
    method?: string; path?: string; body?: unknown; cookie?: string; headers?: Record<string, string>;
    crossSite?: boolean; params?: Record<string, string>;
  } = {},
): Promise<CallResult<T>> {
  const headers = new Headers(opts.headers);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  headers.set('x-real-ip', headers.get('x-real-ip') ?? '203.0.113.7');
  // Browsers send Origin on POST; tests do too unless they are checking SEC-04.
  if ((opts.method ?? 'GET') !== 'GET' && !headers.has('origin') && !opts.crossSite) headers.set('origin', 'http://localhost:3000');
  const req = new NextRequest(new URL(opts.path ?? '/', 'http://localhost:3000'), {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  // PT-16 guard on every call: no route may exceed its registered statement budget (NFR-21).
  const budget = res.headers.get('x-statement-budget');
  const used = Number(res.headers.get('x-statement-count') ?? 0);
  if (budget !== null && used > Number(budget)) {
    throw new Error(`statement budget exceeded: ${used} > ${budget} for ${opts.method ?? 'GET'} ${opts.path ?? '/'}`);
  }
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* redirect or empty */ }
  return {
    status: res.status,
    body: body as T,
    statements: Number(res.headers.get('x-statement-count') ?? -1),
    headers: res.headers,
    setCookie: res.headers.get('set-cookie'),
  };
}

/** "pet_session=..." from a Set-Cookie header, ready to send back. */
export const cookieFrom = (setCookie: string | null) => setCookie?.split(';')[0] ?? '';
