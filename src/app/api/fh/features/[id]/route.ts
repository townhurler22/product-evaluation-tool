// PATCH, DELETE fh/features/:id: rename, describe, move, reorder (FH-603) and delete (FH-604).
import { requireAdmin } from '@/modules/fh/access';
import { idParam } from '@/modules/fh/http';
import { deleteFeature, FeaturePatchBody, patchFeature } from '@/modules/fh/taxonomy';
import { route } from '@/server/http/route';

export const PATCH = route({ route: 'PATCH /api/fh/features/:id', auth: 'required', body: FeaturePatchBody }, async ({ principal, params, body }) => {
  requireAdmin(principal);
  return patchFeature(principal, idParam(params), body);
});

export const DELETE = route({ route: 'DELETE /api/fh/features/:id', auth: 'required' }, async ({ principal, params }) => {
  requireAdmin(principal);
  return deleteFeature(principal, idParam(params));
});
