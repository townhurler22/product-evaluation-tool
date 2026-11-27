// GET share/<token>/fh/forum/posts?sort=&status=&q=&cursor=&now= (FH-1204 to FH-1207). VIEW.
import '@/server/registrations';
import { shareRoute, shareWrongMethod } from '@/modules/core/share/pipeline';
import { SORTS, STATUS_LABEL_MAX, type ForumSort } from '@/modules/fh/forum-domain';
import { listPublicPosts } from '@/modules/fh/forum-public';
import { sanitise } from '@/modules/fh/text';

export const GET = shareRoute({ module: 'fh', capability: 'VIEW', route: 'GET /api/share/:token/fh/forum/posts' }, async ({ req, share }) => {
  const sp = req.nextUrl.searchParams;
  const sort = (SORTS as readonly string[]).includes(sp.get('sort') ?? '') ? sp.get('sort') as ForumSort : 'trending';
  const labels = sp.getAll('status').map((s) => s.slice(0, STATUS_LABEL_MAX)).slice(0, 20);
  const q = sanitise((sp.get('q') ?? '').slice(0, 200));
  const offset = Math.max(0, Math.min(100_000, Number.parseInt(sp.get('cursor') ?? '0', 10) || 0));
  // FH-1205: "now" is fixed when the page loads, so Trending does not reshuffle while paging.
  const nowParam = Number(sp.get('now'));
  const now = Number.isFinite(nowParam) && nowParam > 0 && Math.abs(nowParam - Date.now()) < 7 * 86_400_000 ? nowParam : Date.now();
  return listPublicPosts(share, { sort, labels, q, offset, now });
});

export const POST = shareWrongMethod, PUT = shareWrongMethod, PATCH = shareWrongMethod, DELETE = shareWrongMethod, OPTIONS = shareWrongMethod;
