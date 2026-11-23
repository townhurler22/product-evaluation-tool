// Calls route handlers in-process the way Next.js would.
import { NextRequest } from 'next/server';

type Handler = (req: NextRequest) => Promise<Response>;

export interface CallResult<T = unknown> {
  status: number;
  body: T;
  statements: number;
  headers: Headers;
  setCookie: string | null;
}

export async function call<T = any>( // eslint-disable-line @typescript-eslint/no-explicit-any
  handler: Handler,
  opts: { method?: string; path?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
): Promise<CallResult<T>> {
  const headers = new Headers(opts.headers);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  headers.set('x-real-ip', headers.get('x-real-ip') ?? '203.0.113.7');
  const req = new NextRequest(new URL(opts.path ?? '/', 'http://localhost:3000'), {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await handler(req);
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
