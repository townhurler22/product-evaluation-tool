// GET fh/journeys/:id/cards (FH-655): top-level Product cards linked to this Journey, as the viewer (INT-52).
import { requireMember } from '@/modules/fh/access';
import { idParam } from '@/modules/fh/http';
import { mappedOnBoards } from '@/modules/fh/mapped';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/journeys/:id/cards', auth: 'required' }, async ({ principal, params }) => {
  requireMember(principal);
  return mappedOnBoards(principal, 'journey', idParam(params));
});
