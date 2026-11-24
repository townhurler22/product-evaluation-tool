// POST jb/boards/:id/transfer (JB-1304): owner or manager hands the board (and its journeys) to another active user.
import { z } from 'zod';
import { transferOwnership } from '@/modules/jb/server/collaborators';
import { route } from '@/server/http/route';

const Body = z.strictObject({ userId: z.uuid() });

export const POST = route({ route: 'POST /api/jb/boards/:id/transfer', auth: 'required', body: Body }, async ({ principal, params, body }) => {
  await transferOwnership(principal!, params.id, body.userId);
  return { ok: true };
});
