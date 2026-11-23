// A reference intake sender (ING-39 shape) used by tests: signs exactly as a real client must.
import { NextRequest } from 'next/server';
import { POST as ingest } from '@/app/api/ingest/[module]/v1/[route]/route';
import { sha256Hex, sign } from '@/modules/core/intake/signing';

export interface Sent { status: number; body: any; headers: Headers } // eslint-disable-line @typescript-eslint/no-explicit-any

export async function send(opts: {
  keyId: string; secret: string; route: string; body?: string; requestKey?: string;
  timestamp?: number; module?: string; headers?: Record<string, string>; pathOverride?: string; query?: string;
}): Promise<Sent> {
  const mod = opts.module ?? 'fh';
  const path = opts.pathOverride ?? `/api/ingest/${mod}/v1/${opts.route}`;
  const body = opts.body ?? '';
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const rk = opts.requestKey ?? 'rk-1';
  const headers = new Headers({
    'x-ingest-version': '1', 'x-ingest-key': opts.keyId, 'x-ingest-timestamp': ts,
    'x-ingest-request-key': rk, 'x-ingest-signature': sign(opts.secret, ts, rk, path, sha256Hex(body)),
    'content-type': 'application/json', 'x-real-ip': '198.51.100.20', ...opts.headers,
  });
  const req = new NextRequest(new URL(path + (opts.query ?? ''), 'http://localhost:3000'), {
    method: 'POST', headers, body: body.length ? body : undefined,
  });
  const res = await ingest(req, { params: Promise.resolve({ module: mod, route: opts.route }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
