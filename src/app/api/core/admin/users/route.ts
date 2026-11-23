import { listUsers, requireWorkspaceAdmin } from '@/modules/core/admin';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/core/admin/users', auth: 'required' }, async ({ req, principal }) => {
  requireWorkspaceAdmin(principal);
  const sp = new URL(req.url).searchParams;
  return listUsers(sp.get('cursor'), sp.get('q'));
});
