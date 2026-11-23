import { z } from 'zod';
import { intakeOverview, requireWorkspaceAdmin } from '@/modules/core/admin';
import { createClient } from '@/modules/core/intake/admin';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/core/admin/intake/clients', auth: 'required' }, async ({ principal }) => {
  requireWorkspaceAdmin(principal);
  return intakeOverview();
});

const Body = z.strictObject({
  name: z.string().trim().min(1).max(100),
  environment: z.enum(['staging', 'production']),
  routes: z.array(z.string().regex(/^[a-z][a-z-]{0,63}$/)).min(1).max(10),
  target: z.string().regex(/^[a-z_]+:[A-Za-z0-9_-]+$/).nullish(),
  ratePerMinute: z.number().int().min(1).max(600).optional(),
});

export const POST = route({ route: 'POST /api/core/admin/intake/clients', auth: 'required', body: Body }, async ({ principal, body }) => {
  requireWorkspaceAdmin(principal);
  return Response.json({ client: await createClient(principal.userId, body) }, { status: 201 });
});
