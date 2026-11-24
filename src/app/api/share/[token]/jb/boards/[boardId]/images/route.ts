// GET share/<token>/jb/boards/:boardId/images?ids= (D-30): signed URLs for the link's board and its journeys only.
import '@/server/registrations';
import { shareNotFound, shareRoute } from '@/modules/core/share/pipeline';
import { shareAllows } from '@/modules/jb/server/share';
import { signBoardImages } from '@/modules/jb/server/images';

export const GET = shareRoute({ module: 'jb', capability: 'VIEW', route: 'GET /api/share/:token/jb/boards/:boardId/images' }, async ({ req, share, params }) => {
  if (!shareAllows(share, params.boardId)) return shareNotFound();
  const ids = (new URL(req.url).searchParams.get('ids') ?? '').split(',').filter(Boolean);
  return { urls: await signBoardImages(params.boardId, ids) };
});
