// GET fh/roadmap: Roadmap-view ideas overlapping a window, paginated (FH-761).
import { requireMember } from '@/modules/fh/access';
import { specFromQuery } from '@/modules/fh/http';
import { roadmapRows } from '@/modules/fh/query';
import { DateStr } from '@/modules/fh/schemas';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/roadmap', auth: 'required' }, async ({ req, principal }) => {
  requireMember(principal);
  const sp = req.nextUrl.searchParams;
  const from = DateStr.safeParse(sp.get('from')), to = DateStr.safeParse(sp.get('to'));
  if (!from.success) throw new ApiError('validation', 'Give the window start as YYYY-MM-DD.', { field: 'from' });
  if (!to.success || to.data < from.data) throw new ApiError('validation', 'Give a window end on or after the start.', { field: 'to' });
  return roadmapRows(getDb(), specFromQuery(req), from.data, to.data, sp.get('cursor'));
});
