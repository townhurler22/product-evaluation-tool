// GET jb/boards/:id/content (PERF-24): live nodes, edges, fields and seq in 4 statements; no tombstones (D-22).
import { boardContent } from '@/modules/jb/server/boards';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/jb/boards/:id/content', auth: 'required' }, async ({ principal, params }) =>
  boardContent(principal!, params.id));
