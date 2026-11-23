import { z } from 'zod';
import { setShareLinkPassword } from '@/modules/core/share/links';
import { route } from '@/server/http/route';

const Body = z.strictObject({ password: z.string().min(8).max(200).nullable() });

export const PATCH = route({ route: 'PATCH /api/core/share-links/:id', auth: 'required', body: Body }, async ({ principal, params, body }) => ({
  link: await setShareLinkPassword(principal!, params.id, body.password),
}));
