// Feedback Hub test helpers: sign-in as admin / product / member and typed calls to the FH routes.
import { call, cookieFrom } from './http';
import { requestMagicLink } from '@/modules/core/auth/sign-in';
import { GET as callback } from '@/app/api/auth/callback/route';
import type { ViewSpecInput } from '@/modules/fh/columns';
import { clearPrincipalCache } from '@/modules/core/auth/principal';

export async function signIn(email: string): Promise<string> {
  const link = await requestMagicLink({ email, ipHash: null, origin: 'http://x' });
  const token = new URL(link!).searchParams.get('token')!;
  return cookieFrom((await call(callback, { path: `/api/auth/callback?token=${encodeURIComponent(token)}` })).setCookie);
}

/** Owner (ADMIN), a PRODUCT user (feedback admin) and a plain MEMBER. */
export async function signInAll(pg: { query: (s: string) => Promise<unknown> }) {
  await pg.query(`UPDATE core_setting SET value = '["team.test"]' WHERE key = 'auth.allowed_domains'`);
  const admin = await signIn('owner@example.com');
  const member = await signIn('member@team.test');
  const pm = await signIn('pm@team.test');
  await pg.query(`UPDATE core_user SET role = 'PRODUCT' WHERE email = 'pm@team.test'`);
  clearPrincipalCache();
  return { admin, member, pm };
}

export const specQ = (s: ViewSpecInput = {}) => `spec=${encodeURIComponent(JSON.stringify(s))}`;

export { call };
