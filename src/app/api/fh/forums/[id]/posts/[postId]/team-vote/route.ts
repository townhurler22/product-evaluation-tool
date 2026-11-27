// POST / DELETE fh/forums/:id/posts/:postId/team-vote (FH-1254, OD-14 (a)): "Vote as team member".
import { requireAdmin } from '@/modules/fh/access';
import { teamVote } from '@/modules/fh/forum-admin';
import { idParam } from '@/modules/fh/http';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/fh/forums/:id/posts/:postId/team-vote', auth: 'required' }, async ({ principal, params }) => {
  requireAdmin(principal);
  return teamVote(principal, idParam(params), idParam(params, 'postId'), true);
});

export const DELETE = route({ route: 'DELETE /api/fh/forums/:id/posts/:postId/team-vote', auth: 'required' }, async ({ principal, params }) => {
  requireAdmin(principal);
  return teamVote(principal, idParam(params), idParam(params, 'postId'), false);
});
