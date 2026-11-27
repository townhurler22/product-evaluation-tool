// GET fh/forums/:id, PATCH (FH-1103): rename, prompt, archive, main.
import { getDb } from '@/server/db';
import { requireAdmin } from '@/modules/fh/access';
import { getForum, updateForum } from '@/modules/fh/forum-admin';
import { idParam } from '@/modules/fh/http';
import { PatchForumBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/forums/:id', auth: 'required' }, async ({ principal, params }) => {
  requireAdmin(principal);
  return { forum: await getForum(getDb(), idParam(params)) };
});

export const PATCH = route({ route: 'PATCH /api/fh/forums/:id', auth: 'required', body: PatchForumBody }, async ({ principal, params, body }) => {
  requireAdmin(principal);
  return { forum: await updateForum(principal, idParam(params), body) };
});
