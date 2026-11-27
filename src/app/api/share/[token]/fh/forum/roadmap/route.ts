// GET share/<token>/fh/forum/roadmap (FH-1208, D-36): public summaries in release batches. VIEW.
import '@/server/registrations';
import { shareRoute, shareWrongMethod } from '@/modules/core/share/pipeline';
import { publicRoadmap } from '@/modules/fh/forum-public';

export const GET = shareRoute({ module: 'fh', capability: 'VIEW', route: 'GET /api/share/:token/fh/forum/roadmap' }, async ({ share }) => publicRoadmap(share));

export const POST = shareWrongMethod, PUT = shareWrongMethod, PATCH = shareWrongMethod, DELETE = shareWrongMethod, OPTIONS = shareWrongMethod;
