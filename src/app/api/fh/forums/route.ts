// GET fh/forums (FH-1101): forums with post counts and share links in one request. POST: create (FH-1102).
import { requireAdmin } from '@/modules/fh/access';
import { createForum, listForums } from '@/modules/fh/forum-admin';
import { CreateForumBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/forums', auth: 'required' }, async ({ principal }) => {
  requireAdmin(principal);
  return { forums: await listForums() };
});

export const POST = route({ route: 'POST /api/fh/forums', auth: 'required', body: CreateForumBody }, async ({ principal, body }) => {
  requireAdmin(principal);
  return Response.json({ forum: await createForum(principal, { name: body.name, prompt: body.prompt ?? null }) }, { status: 201 });
});
