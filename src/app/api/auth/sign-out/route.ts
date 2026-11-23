import { NextResponse } from 'next/server';
import { clearedSessionCookie } from '@/modules/core/auth/session';
import { signOut } from '@/modules/core/auth/sign-in';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/auth/sign-out', auth: 'optional' }, async ({ principal }) => {
  if (principal) await signOut(principal.sessionId);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(clearedSessionCookie());
  return res;
});
