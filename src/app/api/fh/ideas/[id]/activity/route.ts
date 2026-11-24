// GET fh/ideas/:id/activity: newest 50, then "Show more" with ?before= (FH-220).
import { requireMember } from '@/modules/fh/access';
import { ideaActivity } from '@/modules/fh/detail';
import { idParam } from '@/modules/fh/http';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/ideas/:id/activity', auth: 'required' }, async ({ req, principal, params }) => {
  requireMember(principal);
  const before = req.nextUrl.searchParams.get('before');
  return ideaActivity(idParam(params), before && !Number.isNaN(Date.parse(before)) ? before : null);
});
