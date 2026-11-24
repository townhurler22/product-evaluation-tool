// PATCH, DELETE fh/milestones/:id.
import { requireAdmin } from '@/modules/fh/access';
import { idParam } from '@/modules/fh/http';
import { deleteMilestone, patchMilestone, MilestonePatchBody } from '@/modules/fh/taxonomy';
import { route } from '@/server/http/route';

export const PATCH = route({ route: 'PATCH /api/fh/milestones/:id', auth: 'required', body: MilestonePatchBody }, async ({ principal, params, body }) => {
  requireAdmin(principal);
  return patchMilestone(principal, idParam(params), body);
});

export const DELETE = route({ route: 'DELETE /api/fh/milestones/:id', auth: 'required' }, async ({ principal, params }) => {
  requireAdmin(principal);
  return deleteMilestone(principal, idParam(params));
});
