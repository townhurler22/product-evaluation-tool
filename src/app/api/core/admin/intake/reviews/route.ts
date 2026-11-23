import { z } from 'zod';
import { requireWorkspaceAdmin } from '@/modules/core/admin';
import { addReview } from '@/modules/core/intake/admin';
import { route } from '@/server/http/route';

const Body = z.strictObject({
  kind: z.enum(['gateway', 'client']),
  clientId: z.uuid().nullish(),
  notes: z.string().trim().min(10).max(5000),
});

export const POST = route({ route: 'POST /api/core/admin/intake/reviews', auth: 'required', body: Body }, async ({ principal, body }) => {
  requireWorkspaceAdmin(principal);
  return Response.json(await addReview(principal.userId, body), { status: 201 });
});
