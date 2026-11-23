// Magic-link and demo sign-in (DECISIONS OD-01). Sessions get a core_session row so they can be revoked.
import { sql } from 'kysely';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { audit } from '../audit';
import { hit } from '../rate-limit';
import { getSettings } from '../settings';
import { newId, normaliseEmail, randomToken, sha256 } from '../util';
import { sealSession, type SessionData } from './session';

const LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_DAYS = 7;

export interface MagicLinkRequest { email: string; ipHash: string | null; origin: string }

/**
 * Always resolves the same way whether or not the email is known, so callers can't probe accounts.
 * Returns the link only so tests and local dev can follow it; routes never put it in a response.
 */
export async function requestMagicLink({ email: raw, ipHash, origin }: MagicLinkRequest): Promise<string | null> {
  const email = normaliseEmail(raw);
  await hit(`magic:${sha256(email)}`, 5, 3600);

  const db = getDb();
  const user = await db.selectFrom('core_user').select(['id', 'status']).where('email', '=', email).executeTakeFirst();
  const owner = process.env.OWNER_EMAIL && normaliseEmail(process.env.OWNER_EMAIL) === email;
  let allowed = owner || (user && user.status !== 'DISABLED');
  if (!user && !owner) {
    const { 'auth.allowed_domains': domains } = await getSettings();
    allowed = domains.includes(email.split('@')[1] ?? '');
  }
  if (!allowed) return null;

  const token = randomToken();
  await db.insertInto('core_magic_link').values({
    id: newId(), email, token_hash: sha256(token), expires_at: new Date(Date.now() + LINK_TTL_MS), ip_hash: ipHash,
  }).execute();
  const link = `${origin}/api/auth/callback?token=${encodeURIComponent(token)}`;
  await sendMagicLinkEmail(email, link);
  return link;
}

async function sendMagicLinkEmail(to: string, link: string) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // Local development only: the link is a credential, so never log it in production.
    if (process.env.NODE_ENV !== 'production') console.info(`[dev] magic link for ${to}: ${link}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.MAIL_FROM ?? 'Product Evaluation Tool <onboarding@resend.dev>',
      to: [to],
      subject: 'Your sign-in link',
      text: `Sign in to the Product Evaluation Tool:\n\n${link}\n\nThe link works once and expires in 15 minutes.`,
    }),
  });
  if (!res.ok) throw new ApiError('unavailable', 'We could not send the email. Try again shortly.');
}

async function startSession(userId: string, epoch: number): Promise<string> {
  const now = Date.now();
  const sessionId = newId();
  await getDb().insertInto('core_session').values({
    id: sessionId, user_id: userId, expires_at: new Date(now + SESSION_DAYS * 86_400_000),
  }).execute();
  const data: SessionData = { userId, sessionId, sessionEpoch: epoch, issuedAt: now, seenAt: now };
  return sealSession(data);
}

/** Consumes a magic-link token. Returns a sealed session cookie value. */
export async function completeMagicLink(token: string, ipHash: string | null): Promise<string> {
  const db = getDb();
  const link = await db.updateTable('core_magic_link')
    .set({ used_at: new Date() })
    .where('token_hash', '=', sha256(token))
    .where('used_at', 'is', null)
    .where('expires_at', '>', new Date())
    .returning('email')
    .executeTakeFirst();
  if (!link) throw new ApiError('gone', 'This sign-in link has expired or was already used.');

  const owner = process.env.OWNER_EMAIL && normaliseEmail(process.env.OWNER_EMAIL) === link.email;
  // ARC-10: unknown emails arrive only via an allowed domain, so they start ACTIVE as MEMBER.
  const user = await db.insertInto('core_user')
    .values({ id: newId(), email: link.email, role: owner ? 'ADMIN' : 'MEMBER', status: 'ACTIVE' })
    .onConflict((oc) => oc.column('email').doUpdateSet({ email: sql`excluded.email` }))
    .returning(['id', 'status', 'session_epoch'])
    .executeTakeFirstOrThrow();
  if (user.status !== 'ACTIVE') throw new ApiError('forbidden', 'Your account is not active.');

  const cookie = await startSession(user.id, user.session_epoch);
  await audit({ actorKind: 'user', actorId: user.id, action: 'core.auth.sign_in', details: { method: 'magic_link' }, ipHash });
  return cookie;
}

export const isDemoMode = () => process.env.DEMO_MODE === '1';
export const DEMO_EMAIL = 'demo@example.com';

/** "Try the demo": signs a visitor in as the seeded demo user. Demo deployment only. */
export async function demoSignIn(ipHash: string | null): Promise<string> {
  if (!isDemoMode()) throw new ApiError('not_found', 'Not found.');
  const user = await getDb().selectFrom('core_user').select(['id', 'session_epoch'])
    .where('email', '=', DEMO_EMAIL).where('status', '=', 'ACTIVE').executeTakeFirst();
  if (!user) throw new ApiError('unavailable', 'The demo is being reset. Try again in a minute.');
  const cookie = await startSession(user.id, user.session_epoch);
  await audit({ actorKind: 'user', actorId: user.id, action: 'core.auth.sign_in', details: { method: 'demo' }, ipHash });
  return cookie;
}

export async function signOut(sessionId: string): Promise<void> {
  await getDb().updateTable('core_session').set({ revoked_at: new Date() }).where('id', '=', sessionId).execute();
}
