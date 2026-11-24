// PATCH, DELETE fh/comments/:id: the author edits or soft-deletes their own comment (FH-219).
import { requireAdmin } from '@/modules/fh/access';
import { editComment } from '@/modules/fh/detail';
import { idParam } from '@/modules/fh/http';
import { CommentBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const PATCH = route({ route: 'PATCH /api/fh/comments/:id', auth: 'required', body: CommentBody }, async ({ principal, params, body }) => {
  requireAdmin(principal);
  return editComment(principal, idParam(params), body.body);
});

export const DELETE = route({ route: 'DELETE /api/fh/comments/:id', auth: 'required' }, async ({ principal, params }) => {
  requireAdmin(principal);
  return editComment(principal, idParam(params), null);
});
