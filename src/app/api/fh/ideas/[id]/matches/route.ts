// GET fh/ideas/:id/matches: stored duplicate suggestions (FH-406, D-05).
import { requireMember } from '@/modules/fh/access';
import { ideaMatches } from '@/modules/fh/detail';
import { idParam } from '@/modules/fh/http';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/ideas/:id/matches', auth: 'required' }, async ({ principal, params }) => {
  requireMember(principal);
  return ideaMatches(idParam(params));
});
