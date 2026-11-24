// POST jb/boards/:id/nodes/:nodeId/journey-sync (§9.4, INT-15 to INT-25): by hand only (OD-19). Statement count is
// independent of the number of boards and cards in the workspace (PT-18, D-26).
import { journeySync } from '@/modules/jb/server/mapping';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/jb/boards/:id/nodes/:nodeId/journey-sync', auth: 'required' }, async ({ principal, params }) =>
  journeySync(principal!, params.id, params.nodeId));
