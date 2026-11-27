// POST fh/ideas/publish/preview (FH-411, FH-412): the main forum and, per idea in order, editable text or the refusal.
import { requireAdmin } from '@/modules/fh/access';
import { publishPreview } from '@/modules/fh/publish';
import { PublishPreviewBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/fh/ideas/publish/preview', auth: 'required', body: PublishPreviewBody }, async ({ principal, body }) => {
  requireAdmin(principal);
  return publishPreview(body.ids);
});
