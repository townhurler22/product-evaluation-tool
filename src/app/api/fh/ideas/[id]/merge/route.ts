// POST fh/ideas/:id/merge (FH-451–454): fold this idea into the target, one way.
import { requireAdmin } from '@/modules/fh/access';
import { idParam } from '@/modules/fh/http';
import { mergeIdeas } from '@/modules/fh/ideas';
import { MergeBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/fh/ideas/:id/merge', auth: 'required', body: MergeBody }, async ({ principal, params, body }) => {
  requireAdmin(principal);
  return mergeIdeas(principal, idParam(params), body.targetId);
});
