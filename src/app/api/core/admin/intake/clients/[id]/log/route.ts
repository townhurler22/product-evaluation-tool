import { clientLog, requireWorkspaceAdmin } from '@/modules/core/admin';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/core/admin/intake/clients/:id/log', auth: 'required' }, async ({ req, principal, params }) => {
  requireWorkspaceAdmin(principal);
  return { log: await clientLog(params.id, new URL(req.url).searchParams.get('before')) };
});
