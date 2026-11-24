// GET fh/people/:id (FH-813), PATCH (FH-814: display name and company; null detaches).
import { requireAdmin, requireMember } from '@/modules/fh/access';
import { idParam } from '@/modules/fh/http';
import { personDetail, updatePerson } from '@/modules/fh/people';
import { PatchPersonBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/people/:id', auth: 'required' }, async ({ principal, params }) => {
  requireMember(principal);
  return personDetail(idParam(params), principal.isFeedbackAdmin);
});

export const PATCH = route({ route: 'PATCH /api/fh/people/:id', auth: 'required', body: PatchPersonBody }, async ({ principal, params, body }) => {
  requireAdmin(principal);
  return updatePerson(principal, idParam(params), body);
});
