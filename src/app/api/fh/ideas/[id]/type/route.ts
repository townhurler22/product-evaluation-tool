// PUT fh/ideas/:id/type (FH-307).
import { requireAdmin } from '@/modules/fh/access';
import { idParam } from '@/modules/fh/http';
import { setType } from '@/modules/fh/ideas';
import { TypeBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const PUT = route({ route: 'PUT /api/fh/ideas/:id/type', auth: 'required', body: TypeBody }, async ({ principal, params, body }) => {
  requireAdmin(principal);
  return { row: await setType(principal, idParam(params), body.ideaType, body.baseVersion) };
});
