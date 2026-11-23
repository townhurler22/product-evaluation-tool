import { NextResponse } from 'next/server';
import { demoSignIn } from '@/modules/core/auth/sign-in';
import { sessionCookie } from '@/modules/core/auth/session';
import { hit } from '@/modules/core/rate-limit';
import { clientIp, hashIp } from '@/modules/core/util';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/auth/demo', auth: 'none' }, async ({ req }) => {
  const ipHash = hashIp(clientIp(req));
  if (ipHash) await hit(`demo-ip:${ipHash}`, 30, 3600);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookie(await demoSignIn(ipHash)));
  return res;
});
