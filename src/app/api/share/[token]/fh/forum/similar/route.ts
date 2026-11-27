// GET share/<token>/fh/forum/similar?title= (FH-1211): up to 4 similar posts while typing. SUBMIT, read only.
import '@/server/registrations';
import { shareRoute, shareWrongMethod } from '@/modules/core/share/pipeline';
import { similarPosts } from '@/modules/fh/forum-public';

export const GET = shareRoute({ module: 'fh', capability: 'SUBMIT', readOnly: true, route: 'GET /api/share/:token/fh/forum/similar' },
  async ({ req, share }) => similarPosts(share, (req.nextUrl.searchParams.get('title') ?? '').slice(0, 400)));

export const POST = shareWrongMethod, PUT = shareWrongMethod, PATCH = shareWrongMethod, DELETE = shareWrongMethod, OPTIONS = shareWrongMethod;
