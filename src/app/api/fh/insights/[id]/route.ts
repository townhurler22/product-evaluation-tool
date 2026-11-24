// DELETE fh/insights/:id (FH-503): idempotent; files removed after commit.
import { requireAdmin } from '@/modules/fh/access';
import { idParam } from '@/modules/fh/http';
import { deleteInsight } from '@/modules/fh/ideas';
import { route } from '@/server/http/route';

export const DELETE = route({ route: 'DELETE /api/fh/insights/:id', auth: 'required' }, async ({ principal, params }) => {
  requireAdmin(principal);
  return deleteInsight(principal, idParam(params));
});
