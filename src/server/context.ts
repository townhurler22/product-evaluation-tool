// Per-request context carried through async calls: request id, statement count and timings.
// Feeds Server-Timing (ARC-40, NFR-23) and the statement budget checks (NFR-21, PT-16).
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  route: string;
  statements: number;
  dbMs: number;   // time spent executing SQL
  poolMs: number; // time spent waiting for a connection
  authMs: number;
  startedAt: number;
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return als.getStore();
}

export function newContext(route: string, requestId: string = crypto.randomUUID()): RequestContext {
  return { requestId, route, statements: 0, dbMs: 0, poolMs: 0, authMs: 0, startedAt: performance.now() };
}
