// POST fh/milestones/assign (FH-752): assign 1–200 ideas, or clear with null.
import { requireAdmin } from '@/modules/fh/access';
import { assignMilestone } from '@/modules/fh/ideas';
import { AssignMilestoneBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/fh/milestones/assign', auth: 'required', body: AssignMilestoneBody }, async ({ principal, body }) => {
  requireAdmin(principal);
  return assignMilestone(principal, body.ids, body.milestoneId);
});
