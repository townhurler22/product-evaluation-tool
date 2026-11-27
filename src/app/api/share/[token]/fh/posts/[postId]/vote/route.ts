// POST / DELETE share/<token>/fh/posts/:postId/vote (FH-1251, FH-1252): upvote or remove. VOTE.
import '@/server/registrations';
import { shareNotFound, shareRoute, shareWrongMethod } from '@/modules/core/share/pipeline';
import { isPostId, jsonWithCookie, unvote, vote, VOTE_LIMITS } from '@/modules/fh/forum-public';

export const POST = shareRoute({ module: 'fh', capability: 'VOTE', identity: true, limits: VOTE_LIMITS, route: 'POST /api/share/:token/fh/posts/:postId/vote' }, async ({ share, params }) => {
  if (!isPostId(params.postId)) return shareNotFound();
  const out = await vote(share, params.postId);
  return out ? jsonWithCookie(out.result, out.setCookie) : shareNotFound();
});

export const DELETE = shareRoute({ module: 'fh', capability: 'VOTE', identity: true, limits: VOTE_LIMITS, route: 'DELETE /api/share/:token/fh/posts/:postId/vote' }, async ({ share, params }) => {
  if (!isPostId(params.postId)) return shareNotFound();
  const out = await unvote(share, params.postId);
  return out ?? shareNotFound();
});

export const GET = shareWrongMethod, PUT = shareWrongMethod, PATCH = shareWrongMethod, OPTIONS = shareWrongMethod;
