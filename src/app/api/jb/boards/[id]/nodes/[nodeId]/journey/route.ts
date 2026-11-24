// GET jb/boards/:id/nodes/:nodeId/journey (§9.4, INT-42): a top-level card's Journey state. Same read as the panel
// summary, so the two can never disagree (D-29).
import { panelSummary } from '@/modules/jb/server/mapping';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/jb/boards/:id/nodes/:nodeId/journey', auth: 'required' }, async ({ principal, params }) =>
  panelSummary(principal!, params.id, params.nodeId, 'open'));
