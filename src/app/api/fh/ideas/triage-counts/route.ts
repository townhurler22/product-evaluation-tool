// GET fh/ideas/triage-counts?spec= (FH-403, FH-404): source chips and the "Accept all from calls / support" counts.
import { requireMember } from '@/modules/fh/access';
import { specFromQuery } from '@/modules/fh/http';
import { triageCounts } from '@/modules/fh/query';
import { getDb } from '@/server/db';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/ideas/triage-counts', auth: 'required' }, async ({ req, principal }) => {
  requireMember(principal);
  return triageCounts(getDb(), specFromQuery(req));
});
