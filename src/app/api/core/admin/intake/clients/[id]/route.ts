import { z } from 'zod';
import { requireWorkspaceAdmin } from '@/modules/core/admin';
import { updateClient } from '@/modules/core/intake/admin';
import { route } from '@/server/http/route';

const Body = z.strictObject({
  routes: z.array(z.string().regex(/^[a-z][a-z-]{0,63}$/)).min(1).max(10).optional(),
  ratePerMinute: z.number().int().min(1).max(600).optional(),
});

export const PATCH = route({ route: 'PATCH /api/core/admin/intake/clients/:id', auth: 'required', body: Body },
  async ({ principal, params, body }) => {
    requireWorkspaceAdmin(principal);
    return { client: await updateClient(principal.userId, params.id, body) };
  });
