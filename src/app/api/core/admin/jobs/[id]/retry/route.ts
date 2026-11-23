import { requireWorkspaceAdmin, retryJob } from '@/modules/core/admin';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/core/admin/jobs/:id/retry', auth: 'required' }, async ({ principal, params }) => {
  requireWorkspaceAdmin(principal);
  return { job: await retryJob(principal, params.id) };
});
