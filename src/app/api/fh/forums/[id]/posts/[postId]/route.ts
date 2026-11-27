// PATCH fh/forums/:id/posts/:postId (FH-1107): admin edit. DELETE (FH-1108): post-delete grant only (OD-03).
import { requireAdmin, requireMember } from '@/modules/fh/access';
import { deletePost, editPost } from '@/modules/fh/forum-admin';
import { idParam } from '@/modules/fh/http';
import { PostTextBody } from '@/modules/fh/schemas';
import { ApiError } from '@/server/http/errors';
import { route } from '@/server/http/route';

export const PATCH = route({ route: 'PATCH /api/fh/forums/:id/posts/:postId', auth: 'required', body: PostTextBody }, async ({ principal, params, body }) => {
  requireAdmin(principal);
  return editPost(principal, idParam(params), idParam(params, 'postId'), body);
});

export const DELETE = route({ route: 'DELETE /api/fh/forums/:id/posts/:postId', auth: 'required' }, async ({ principal, params }) => {
  requireMember(principal);
  // SEC-02: the grant is never implied by a role, including workspace admin.
  if (!principal.canDeletePosts) throw new ApiError('forbidden', 'Deleting forum posts needs the post-delete permission.');
  return deletePost(principal, idParam(params), idParam(params, 'postId'));
});
