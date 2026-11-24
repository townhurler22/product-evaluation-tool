// GET jb/boards/:id/nodes/:nodeId/ideas?scope=&featureId=&cursor= (INT-40): loaded only when expanded.
import { cardIdeas, parseScope } from '@/modules/jb/server/mapping';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/jb/boards/:id/nodes/:nodeId/ideas', auth: 'required' }, async ({ req, principal, params }) => {
  const sp = req.nextUrl.searchParams;
  return cardIdeas(principal!, params.id, params.nodeId, {
    scope: parseScope(sp.get('scope')), featureId: sp.get('featureId')?.toLowerCase() ?? null, cursor: sp.get('cursor'),
  });
});
