// GET fh/features/:id/cards (FH-605, FH-222): Product cards linked to this Feature, as the viewer (INT-52).
import { requireMember } from '@/modules/fh/access';
import { idParam } from '@/modules/fh/http';
import { mappedOnBoards } from '@/modules/fh/mapped';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/features/:id/cards', auth: 'required' }, async ({ principal, params }) => {
  requireMember(principal);
  return mappedOnBoards(principal, 'feature', idParam(params));
});
