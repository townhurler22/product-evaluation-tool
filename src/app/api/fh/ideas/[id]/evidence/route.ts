// GET fh/ideas/:id/evidence: insights and counted people (§4.6).
import { requireMember } from '@/modules/fh/access';
import { ideaEvidence } from '@/modules/fh/detail';
import { idParam } from '@/modules/fh/http';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/ideas/:id/evidence', auth: 'required' }, async ({ principal, params }) => {
  requireMember(principal);
  return ideaEvidence(idParam(params));
});
