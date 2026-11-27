// GET fh/forums/:id/posts?offset= (FH-1106): most votes first, then newest; the only place voters are shown.
import { requireAdmin } from '@/modules/fh/access';
import { listForumPosts } from '@/modules/fh/forum-admin';
import { idParam, offsetParam } from '@/modules/fh/http';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/forums/:id/posts', auth: 'required' }, async ({ req, principal, params }) => {
  requireAdmin(principal);
  return listForumPosts(principal, idParam(params), offsetParam(req.nextUrl.searchParams.get('offset')));
});
