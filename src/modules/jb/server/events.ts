// After-commit realtime publishing for boards (§3.7, ARC-22, ARC-24). Best effort; never fails a write.
import { after } from 'next/server';
import { publish } from '@/modules/core/service';

export const MAX_EVENT_BYTES = 8 * 1024;

type Listener = (channel: string, event: string, payload: Record<string, unknown>) => void;
const listeners = new Set<Listener>();
/** Tests observe published events through this hook. */
export function onBoardEvent(l: Listener) { listeners.add(l); return () => listeners.delete(l); }

export const boardChannel = (boardId: string) => `jb.board.${boardId}`;
export const eventBytes = (payload: unknown) => Buffer.byteLength(JSON.stringify(payload));

/** Runs after the response is sent when inside a request; immediately otherwise (scripts, tests). */
export function afterCommit(fn: () => Promise<unknown>) {
  const run = () => fn().catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'after-commit task failed', err: String(e) })));
  try { after(run); } catch { void run(); }
}

export function emit(channel: string, event: string, payload: Record<string, unknown>) {
  for (const l of listeners) l(channel, event, payload);
  afterCommit(() => publish(channel, event, payload));
}

/** ops.applied with the batch, or ops.available {seq} when the payload is over 8 KB (JB-1501, ARC-24). */
export function emitOps(boardId: string, payload: { seq: number; batchId: string; clientId: string; userId: string; ops: unknown[]; results: unknown[] }) {
  if (eventBytes(payload) > MAX_EVENT_BYTES) emit(boardChannel(boardId), 'ops.available', { seq: payload.seq });
  else emit(boardChannel(boardId), 'ops.applied', payload);
}
