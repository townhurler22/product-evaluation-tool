// GET jb/boards/:id/nodes/:nodeId/demand?scope= (INT-42, INT-43, INT-48): the Product card panel's Feedback Hub
// summary, from the same sets as the overlay (D-29).
import { panelSummary, parseScope } from '@/modules/jb/server/mapping';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/jb/boards/:id/nodes/:nodeId/demand', auth: 'required' }, async ({ req, principal, params }) =>
  panelSummary(principal!, params.id, params.nodeId, parseScope(req.nextUrl.searchParams.get('scope'))));
