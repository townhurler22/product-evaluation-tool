import { NextResponse } from 'next/server';
import { completeMagicLink } from '@/modules/core/auth/sign-in';
import { sessionCookie } from '@/modules/core/auth/session';
import { clientIp, hashIp } from '@/modules/core/util';
import { ApiError } from '@/server/http/errors';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/auth/callback', auth: 'none' }, async ({ req }) => {
  const token = new URL(req.url).searchParams.get('token');
  if (!token) throw new ApiError('validation', 'Missing token.', { field: 'token' });
  const cookie = await completeMagicLink(token, hashIp(clientIp(req)));
  const res = NextResponse.redirect(new URL('/', req.url), 303);
  res.cookies.set(sessionCookie(cookie));
  return res;
});
