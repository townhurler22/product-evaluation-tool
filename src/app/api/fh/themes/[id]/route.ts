// PATCH, DELETE fh/themes/:id.
import { requireAdmin } from '@/modules/fh/access';
import { idParam } from '@/modules/fh/http';
import { deleteTheme, patchTheme, ThemePatchBody } from '@/modules/fh/taxonomy';
import { route } from '@/server/http/route';

export const PATCH = route({ route: 'PATCH /api/fh/themes/:id', auth: 'required', body: ThemePatchBody }, async ({ principal, params, body }) => {
  requireAdmin(principal);
  return patchTheme(principal, idParam(params), body);
});

export const DELETE = route({ route: 'DELETE /api/fh/themes/:id', auth: 'required' }, async ({ principal, params }) => {
  requireAdmin(principal);
  return deleteTheme(principal, idParam(params));
});
