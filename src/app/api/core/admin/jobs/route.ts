import { listDeadJobs, requireWorkspaceAdmin } from '@/modules/core/admin';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/core/admin/jobs', auth: 'required' }, async ({ principal }) => {
  requireWorkspaceAdmin(principal);
  return { dead: await listDeadJobs() };
});
