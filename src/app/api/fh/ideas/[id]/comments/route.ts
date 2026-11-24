// GET, POST fh/ideas/:id/comments: internal notes, feedback admins only (FH-219).
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/modules/fh/access';
import { addComment, listComments } from '@/modules/fh/detail';
import { idParam } from '@/modules/fh/http';
import { CommentBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/ideas/:id/comments', auth: 'required' }, async ({ principal, params }) => {
  requireAdmin(principal);
  return listComments(idParam(params));
});

export const POST = route({ route: 'POST /api/fh/ideas/:id/comments', auth: 'required', body: CommentBody }, async ({ principal, params, body }) => {
  requireAdmin(principal);
  return NextResponse.json(await addComment(principal, idParam(params), body.body), { status: 201 });
});
