// PUT fh/ideas/:id/dates (FH-766: never changes status).
import { requireAdmin } from '@/modules/fh/access';
import { idParam } from '@/modules/fh/http';
import { setDates } from '@/modules/fh/ideas';
import { DatesBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const PUT = route({ route: 'PUT /api/fh/ideas/:id/dates', auth: 'required', body: DatesBody }, async ({ principal, params, body }) => {
  requireAdmin(principal);
  return { row: await setDates(principal, idParam(params), body.startDate, body.dueDate, body.baseVersion) };
});
