// Per-instance principal cache (ARC-07, ARC-12): 30 s TTL, ≤ 10,000 entries, one query on a miss.
import { getDb } from '@/server/db';
import type { SessionData } from './session';

export type Role = 'ADMIN' | 'PRODUCT' | 'MEMBER';

export interface Principal {
  userId: string;
  sessionId: string;
  role: Role;
  /** Feedback admin = ADMIN or PRODUCT (fh_grant joins in at P1, ARC-13). */
  isFeedbackAdmin: boolean;
  isWorkspaceAdmin: boolean;
}

interface CachedUser { role: Role; status: string; sessionEpoch: number; expires: number }

const TTL_MS = 30_000;
const MAX = 10_000;
const cache = new Map<string, CachedUser>();

async function loadUser(userId: string): Promise<CachedUser | null> {
  const row = await getDb()
    .selectFrom('core_user')
    .select(['role', 'status', 'session_epoch'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!row) return null;
  return { role: row.role, status: row.status, sessionEpoch: row.session_epoch, expires: Date.now() + TTL_MS };
}

export async function loadPrincipal(session: SessionData): Promise<Principal | null> {
  let u = cache.get(session.userId);
  if (!u || u.expires < Date.now()) {
    const loaded = await loadUser(session.userId);
    if (!loaded) { cache.delete(session.userId); return null; }
    if (cache.size >= MAX) cache.delete(cache.keys().next().value!); // drop oldest insertion
    cache.set(session.userId, loaded);
    u = loaded;
  }
  if (u.status !== 'ACTIVE' || session.sessionEpoch < u.sessionEpoch) return null;
  return {
    userId: session.userId,
    sessionId: session.sessionId,
    role: u.role,
    isFeedbackAdmin: u.role === 'ADMIN' || u.role === 'PRODUCT',
    isWorkspaceAdmin: u.role === 'ADMIN',
  };
}

/** The instance that changes a user forgets it at once (ARC-12); others within the TTL. */
export function forgetPrincipal(userId: string) { cache.delete(userId); }
export function clearPrincipalCache() { cache.clear(); }
