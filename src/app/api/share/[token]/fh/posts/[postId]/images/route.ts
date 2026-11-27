// GET share/<token>/fh/posts/:postId/images (FH-1209): signed URLs for a post of this forum only (SEC-10). VIEW.
import '@/server/registrations';
import { shareNotFound, shareRoute, shareWrongMethod } from '@/modules/core/share/pipeline';
import { isPostId, postImages } from '@/modules/fh/forum-public';

export const GET = shareRoute({ module: 'fh', capability: 'VIEW', route: 'GET /api/share/:token/fh/posts/:postId/images' }, async ({ share, params }) => {
  if (!isPostId(params.postId)) return shareNotFound();
  return (await postImages(share, params.postId)) ?? shareNotFound();
});

export const POST = shareWrongMethod, PUT = shareWrongMethod, PATCH = shareWrongMethod, DELETE = shareWrongMethod, OPTIONS = shareWrongMethod;
