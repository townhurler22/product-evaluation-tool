// POST fh/ideas/delete (FH-456): 1–200 ids; forum posts are kept.
import { requireAdmin } from '@/modules/fh/access';
import { deleteIdeas } from '@/modules/fh/ideas';
import { DeleteBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/fh/ideas/delete', auth: 'required', body: DeleteBody }, async ({ principal, body }) => {
  requireAdmin(principal);
  const { deleted, filesRemoved } = await deleteIdeas(principal, body.ids);
  return { deleted, filesRemoved };
});
