import { z } from 'zod';
import { requireWorkspaceAdmin } from '@/modules/core/admin';
import { setPause } from '@/modules/core/intake/admin';
import { route } from '@/server/http/route';

const Body = z.strictObject({
  module: z.literal('fh').optional(),
  clientId: z.uuid().optional(),
  paused: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

export const PUT = route({ route: 'PUT /api/core/admin/intake/pause', auth: 'required', body: Body }, async ({ principal, body }) => {
  requireWorkspaceAdmin(principal);
  await setPause(principal.userId, body);
  return { ok: true };
});
