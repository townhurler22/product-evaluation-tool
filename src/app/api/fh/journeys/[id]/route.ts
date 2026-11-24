// DELETE fh/journeys/:id (FH-653): memberships go, ideas stay.
import { requireAdmin } from '@/modules/fh/access';
import { idParam } from '@/modules/fh/http';
import { deleteJourney } from '@/modules/fh/taxonomy';
import { route } from '@/server/http/route';

export const DELETE = route({ route: 'DELETE /api/fh/journeys/:id', auth: 'required' }, async ({ principal, params }) => {
  requireAdmin(principal);
  return deleteJourney(principal, idParam(params));
});
