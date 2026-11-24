// PUT fh/ideas/:id/status (FH-301).
import { requireAdmin } from '@/modules/fh/access';
import type { StatusKey } from '@/modules/fh/domain';
import { idParam } from '@/modules/fh/http';
import { setStatus } from '@/modules/fh/ideas';
import { StatusBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const PUT = route({ route: 'PUT /api/fh/ideas/:id/status', auth: 'required', body: StatusBody }, async ({ principal, params, body }) => {
  requireAdmin(principal);
  return { row: await setStatus(principal, idParam(params), body.status as StatusKey, body.comment, body.baseVersion) };
});
