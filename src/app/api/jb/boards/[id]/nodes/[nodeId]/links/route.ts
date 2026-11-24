// GET, POST, DELETE jb/boards/:id/nodes/:nodeId/links (§9.1, INT-01 to INT-05): Core links, relation by board level.
// Link changes are not ops and are not undoable (JB-1705).
import { z } from 'zod';
import { addCardLink, listCardLinks, removeCardLink } from '@/modules/jb/server/mapping';
import { ApiError } from '@/server/http/errors';
import { route } from '@/server/http/route';

const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Must be an id');
const LinkBody = z.strictObject({ relation: z.enum(['maps-to-feature', 'maps-to-journey']).optional(), featureId: Uuid });

export const GET = route({ route: 'GET /api/jb/boards/:id/nodes/:nodeId/links', auth: 'required' }, async ({ principal, params }) =>
  listCardLinks(principal!, params.id, params.nodeId));

export const POST = route({ route: 'POST /api/jb/boards/:id/nodes/:nodeId/links', auth: 'required', body: LinkBody }, async ({ principal, params, body }) =>
  addCardLink(principal!, params.id, params.nodeId, body));

export const DELETE = route({ route: 'DELETE /api/jb/boards/:id/nodes/:nodeId/links', auth: 'required' }, async ({ req, principal, params }) => {
  const sp = req.nextUrl.searchParams;
  const relation = sp.get('relation') ?? '';
  const toId = sp.get('toId') ?? '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(toId)) throw new ApiError('validation', 'toId is required.', { field: 'toId' });
  return removeCardLink(principal!, params.id, params.nodeId, { relation, toId: toId.toLowerCase() });
});
