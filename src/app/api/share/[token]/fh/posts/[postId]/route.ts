// PATCH share/<token>/fh/posts/:postId (FH-1214): the visitor's own post in this forum, else the share 404. SUBMIT.
import '@/server/registrations';
import { shareNotFound, shareRoute, shareWrongMethod } from '@/modules/core/share/pipeline';
import { cleanPostText, editOwnPost, isPostId, SUBMIT_LIMITS } from '@/modules/fh/forum-public';
import { ApiError } from '@/server/http/errors';

export const PATCH = shareRoute({ module: 'fh', capability: 'SUBMIT', identity: true, limits: SUBMIT_LIMITS, route: 'PATCH /api/share/:token/fh/posts/:postId' }, async ({ req, share, params }) => {
  if (!isPostId(params.postId)) return shareNotFound();
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { throw new ApiError('validation', 'Body must be JSON.'); }
  const post = await editOwnPost(share, params.postId, cleanPostText(body ?? {}));
  return post ? { post } : shareNotFound();
});

export const GET = shareWrongMethod, POST = shareWrongMethod, PUT = shareWrongMethod, DELETE = shareWrongMethod, OPTIONS = shareWrongMethod;
