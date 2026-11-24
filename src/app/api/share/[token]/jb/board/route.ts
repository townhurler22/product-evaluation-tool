// GET share/<token>/jb/board (§11.3, JB-1403, OD-24 (a)): the board and its journeys, read-only. VIEW only.
import '@/server/registrations';
import { shareRoute } from '@/modules/core/share/pipeline';
import { shareBoardMetas, shareContent } from '@/modules/jb/server/share';

export const GET = shareRoute({ module: 'jb', capability: 'VIEW', route: 'GET /api/share/:token/jb/board' }, async ({ share }) => {
  const metas = await shareBoardMetas(share);
  return { ...metas, content: await shareContent(share, share.targetId) };
});
