// POST fh/ideas/publish (FH-412, FH-413): publishes the edited items to the main forum, each in its own transaction.
import { requireAdmin } from '@/modules/fh/access';
import { publishIdeasToForum } from '@/modules/fh/publish';
import { PublishBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/fh/ideas/publish', auth: 'required', body: PublishBody, maxBodyBytes: 600 * 1024 }, async ({ principal, body }) => {
  requireAdmin(principal);
  return publishIdeasToForum(principal, body.forumId, body.items);
});
