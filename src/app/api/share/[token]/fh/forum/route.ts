// GET share/<token>/fh/forum (§11.3, FH-1204): forum name and prompt, status chips, what the link allows. VIEW.
import '@/server/registrations';
import { shareRoute, shareWrongMethod } from '@/modules/core/share/pipeline';
import { forumMeta } from '@/modules/fh/forum-public';

export const GET = shareRoute({ module: 'fh', capability: 'VIEW', route: 'GET /api/share/:token/fh/forum' }, async ({ share }) => forumMeta(share));

// SEC-07: a wrong method answers the same 404 as a missing link.
export const POST = shareWrongMethod, PUT = shareWrongMethod, PATCH = shareWrongMethod, DELETE = shareWrongMethod, OPTIONS = shareWrongMethod;
