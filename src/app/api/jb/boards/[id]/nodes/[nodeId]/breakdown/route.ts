// GET jb/boards/:id/nodes/:nodeId/breakdown?scope= (INT-41): loaded on hover of the count, once per card and scope.
import { cardBreakdown, parseScope } from '@/modules/jb/server/mapping';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/jb/boards/:id/nodes/:nodeId/breakdown', auth: 'required' }, async ({ req, principal, params }) =>
  cardBreakdown(principal!, params.id, params.nodeId, parseScope(req.nextUrl.searchParams.get('scope'))));
