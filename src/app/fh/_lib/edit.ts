'use client';

// Inline edits (FH-104, PERF-08): update the cached row at once, send baseVersion, apply the server's row, and on
// failure roll back. A 409 reports "This idea changed since you loaded it" so the caller can offer a row reload.
import type { IdeaRow } from '@/modules/fh/rows';
import { api, ApiFailure } from './api';
import { rowStore } from './rows';

export type EditValue = string | number | boolean | null | string[];

/** Maps a column edit to its route and the optimistic change to the row. */
function plan(row: IdeaRow, column: string, value: EditValue): { path: string; method: string; body: Record<string, unknown>; optimistic: Partial<IdeaRow> } {
  const base = `/api/fh/ideas/${row.id}`;
  const patch = (field: string) => ({ path: base, method: 'PATCH', body: { [field]: value, baseVersion: row.version }, optimistic: { [field]: value } as Partial<IdeaRow> });
  switch (column) {
    case 'status': {
      const v = String(value);
      return { path: `${base}/status`, method: 'PUT', body: { status: v, baseVersion: row.version },
        optimistic: v.startsWith('BUG_') ? { bugStatus: v.slice(4) as IdeaRow['bugStatus'] } : { status: v.slice(5) as IdeaRow['status'] } };
    }
    case 'type': return { path: `${base}/type`, method: 'PUT', body: { ideaType: value, baseVersion: row.version }, optimistic: { ideaType: value as IdeaRow['ideaType'] } };
    case 'themes': return { path: `${base}/themes`, method: 'PUT', body: { ids: value, baseVersion: row.version }, optimistic: { themeIds: value as string[] } };
    case 'companies': return { path: `${base}/companies`, method: 'PUT', body: { ids: value, baseVersion: row.version }, optimistic: {} };
    case 'owner': return patch('ownerId');
    case 'feature': return patch('featureId');
    case 'milestone': return patch('milestoneId');
    case 'committed': return patch('isCommitted');
    case 'dealbreaker': return patch('isDealbreaker');
    default: return patch(column); // title, scores, startDate, dueDate, estimateDays, description, publicSummary
  }
}

export interface EditResult { ok: boolean; row?: IdeaRow; conflict?: boolean; message?: string; field?: string }

export async function saveField(rowId: string, column: string, value: EditValue): Promise<EditResult> {
  const row = rowStore.get(rowId);
  if (!row) return { ok: false, message: 'This idea is no longer loaded.' };
  const p = plan(row, column, value);
  const before = rowStore.patch(rowId, p.optimistic);
  try {
    const res = await api<{ row: IdeaRow }>(p.path, { method: p.method, body: p.body });
    rowStore.upsert([res.row]);
    return { ok: true, row: res.row };
  } catch (e) {
    if (before) rowStore.restore(before);
    const f = e instanceof ApiFailure ? e : null;
    return { ok: false, conflict: f?.status === 409 && f.message.startsWith('This idea changed'), message: (e as Error).message, field: f?.details?.field as string | undefined };
  }
}

/** Reloads one row from the server (after a conflict). */
export async function reloadRow(id: string) {
  const r = await api<{ rows: IdeaRow[] }>(`/api/fh/ideas?ids=${id}`);
  if (r.rows[0]) rowStore.restore(r.rows[0]);
  return r.rows[0];
}
