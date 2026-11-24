// Journey Boards test helpers: sign-in, board creation and op batches through the real routes.
import { call, cookieFrom } from './http';
import { requestMagicLink } from '@/modules/core/auth/sign-in';
import { GET as callback } from '@/app/api/auth/callback/route';
import { POST as createRoute } from '@/app/api/jb/boards/route';
import { POST as opsRoute } from '@/app/api/jb/boards/[id]/ops/route';
import type { Op } from '@/modules/jb/ops';

export async function signIn(email: string) {
  const link = await requestMagicLink({ email, ipHash: null, origin: 'http://x' });
  return cookieFrom((await call(callback, { path: `/api/auth/callback?token=${encodeURIComponent(new URL(link!).searchParams.get('token')!)}` })).setCookie);
}

export async function createBoard(cookie: string, body: Record<string, unknown> = { name: 'Board' }) {
  const r = await call(createRoute, { method: 'POST', path: '/api/jb/boards', cookie, body });
  if (r.status !== 201) throw new Error(`create board failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { meta: { id: string; rights: Record<string, unknown>; workspaceCanEdit: boolean }; content: { seq: number; nodes: unknown[]; fields: { id: string }[] } };
}

let n = 0;
export const batchId = () => `batch-${Date.now()}-${++n}`;

export function sendOps(cookie: string, boardId: string, ops: Op[] | unknown[], extra: Record<string, unknown> = {}) {
  return call(opsRoute, {
    method: 'POST', path: `/api/jb/boards/${boardId}/ops`, cookie, params: { id: boardId },
    body: { batchId: batchId(), clientId: 'client-test', protocol: 1, ops, ...extra },
  });
}

export const card = (id: string, x = 0, y = 0, data: Record<string, unknown> = {}, kind = 'design-card'): Op =>
  ({ type: 'node', op: 'create', id, value: { kind, x, y, sortKey: 'V', data: { title: id, ...data } } });
export const edge = (id: string, source: string, target: string): Op =>
  ({ type: 'edge', op: 'create', id, value: { source, target, sortKey: 'V', data: {} } });
