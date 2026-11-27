// Request helpers for Feedback Hub routes.
import type { NextRequest } from 'next/server';
import { ApiError } from '@/server/http/errors';
import { isUuid, ViewSpecSchema, type ViewSpec } from './columns';

/** `?spec=<json>` on GET routes (PERF-11: the whole view travels as one viewSpec). */
export function specFromQuery(req: NextRequest): ViewSpec {
  const raw = req.nextUrl.searchParams.get('spec');
  let json: unknown = {};
  if (raw) {
    try { json = JSON.parse(raw); } catch { throw new ApiError('validation', 'The view is not valid.', { field: 'spec' }); }
  }
  const parsed = ViewSpecSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError('validation', issue.message, { field: ['spec', ...issue.path].join('.') });
  }
  return parsed.data;
}

/** Route ids are validated before any SQL: a malformed id is simply not found. */
export function idParam(params: Record<string, string>, name = 'id'): string {
  const v = params[name];
  if (!isUuid(v)) throw new ApiError('not_found', 'Not found.');
  return v;
}

/** `?offset=` for server-paginated management lists. */
export const offsetParam = (v: string | null) => Math.max(0, Math.min(1_000_000, Number.parseInt(v ?? '0', 10) || 0));
