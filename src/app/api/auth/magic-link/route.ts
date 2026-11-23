import { z } from 'zod';
import { requestMagicLink } from '@/modules/core/auth/sign-in';
import { hit } from '@/modules/core/rate-limit';
import { clientIp, hashIp } from '@/modules/core/util';
import { route } from '@/server/http/route';

const Body = z.object({ email: z.email().max(254) });

export const POST = route({ route: 'POST /api/auth/magic-link', auth: 'none', body: Body }, async ({ req, body }) => {
  const ipHash = hashIp(clientIp(req));
  if (ipHash) await hit(`magic-ip:${ipHash}`, 20, 3600);
  await requestMagicLink({ email: body.email, ipHash, origin: new URL(req.url).origin });
  // Same answer whether or not the address is known.
  return { ok: true, message: 'If that address can sign in, a link is on its way.' };
});
