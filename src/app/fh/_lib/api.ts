// Browser API client for Feedback Hub. Errors keep the server's envelope (ARC-08) so fields can show its message.
import type { ViewSpecInput } from '@/modules/fh/columns';

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init?.signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiFailure(res.status, body.code ?? 'internal', body.message ?? `Request failed (${res.status})`, body.details);
  return body as T;
}

export const specParam = (s: ViewSpecInput) => `spec=${encodeURIComponent(JSON.stringify(s))}`;

/** Streams the CSV and saves it with the server's file name (FH-157). */
export async function downloadExport(body: { viewSpec: ViewSpecInput; ids?: string[]; columns: string[] }): Promise<number> {
  const res = await fetch('/api/fh/ideas/export', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new ApiFailure(res.status, b.code ?? 'internal', b.message ?? 'Export failed');
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'ideas.csv';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return Number(res.headers.get('x-export-rows') ?? 0);
}
