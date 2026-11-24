// GET share/<token>/jb/boards/:boardId/content: the link's board or one of its journeys only (SEC-10, INV-15).
import '@/server/registrations';
import { shareNotFound, shareRoute } from '@/modules/core/share/pipeline';
import { shareAllows, shareContent } from '@/modules/jb/server/share';

export const GET = shareRoute({ module: 'jb', capability: 'VIEW', route: 'GET /api/share/:token/jb/boards/:boardId/content' }, async ({ share, params }) => {
  if (!shareAllows(share, params.boardId)) return shareNotFound();
  return shareContent(share, params.boardId);
});
