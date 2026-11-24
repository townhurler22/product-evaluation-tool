// Per-instance principal cache (ARC-07, ARC-12): 30 s TTL, ≤ 10,000 entries, one query on a miss.
import { getDb } from '@/server/db';
import type { SessionData } from './session';

export type Role = 'ADMIN' | 'PRODUCT' | 'MEMBER';

export interface Principal {
  userId: string;
  sessionId: string;
  role: Role;
  /** Feedback admin = ADMIN or PRODUCT or an fh_grant with role ADMIN (ARC-13). */
  isFeedbackAdmin: boolean;
  /** Post-delete grant: never implied by a role (OD-03, SEC-02). */
  canDeletePosts: boolean;
  isWorkspaceAdmin: boolean;
}

interface CachedUser {
  role: Role; status: string; sessionEpoch: number; grantAdmin: boolean; canDeletePosts: boolean; expires: number;
}

const TTL_MS = 30_000;
const MAX = 10_000;
const cache = new Map<string, CachedUser>();

/** User row joined to its grants: one statement (§3.4 step 3). */
async function loadUser(userId: string): Promise<CachedUser | null> {
  const row = await getDb()
    .selectFrom('core_user as u')
    .leftJoin('fh_grant as g', 'g.user_id', 'u.id')
    .select(['u.role', 'u.status', 'u.session_epoch', 'g.role as grant_role', 'g.can_delete_posts'])
    .where('u.id', '=', userId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    role: row.role, status: row.status, sessionEpoch: row.session_epoch,
    grantAdmin: row.grant_role === 'ADMIN', canDeletePosts: row.can_delete_posts === true,
    expires: Date.now() + TTL_MS,
  };
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
    isFeedbackAdmin: u.role === 'ADMIN' || u.role === 'PRODUCT' || u.grantAdmin,
    canDeletePosts: u.canDeletePosts,
    isWorkspaceAdmin: u.role === 'ADMIN',
  };
}

/** The instance that changes a user forgets it at once (ARC-12); others within the TTL. */
export function forgetPrincipal(userId: string) { cache.delete(userId); }
export function clearPrincipalCache() { cache.clear(); }
