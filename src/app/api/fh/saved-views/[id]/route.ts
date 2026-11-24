// PATCH, DELETE fh/saved-views/:id (FH-903): owners; admins for shared views; built-ins are fixed.
import { requireMember } from '@/modules/fh/access';
import { idParam } from '@/modules/fh/http';
import { deleteSavedView, patchSavedView, SavedViewPatchBody } from '@/modules/fh/saved-views';
import { route } from '@/server/http/route';

export const PATCH = route({ route: 'PATCH /api/fh/saved-views/:id', auth: 'required', body: SavedViewPatchBody }, async ({ principal, params, body }) => {
  requireMember(principal);
  return patchSavedView(principal, idParam(params), body);
});

export const DELETE = route({ route: 'DELETE /api/fh/saved-views/:id', auth: 'required' }, async ({ principal, params }) => {
  requireMember(principal);
  return deleteSavedView(principal, idParam(params));
});
