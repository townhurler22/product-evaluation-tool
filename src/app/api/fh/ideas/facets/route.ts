// GET fh/ideas/facets: counts for one column before column filters (FH-107).
import { requireMember } from '@/modules/fh/access';
import { specFromQuery } from '@/modules/fh/http';
import { facets } from '@/modules/fh/query';
import { getDb } from '@/server/db';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/ideas/facets', auth: 'required' }, async ({ req, principal }) => {
  requireMember(principal);
  const sp = req.nextUrl.searchParams;
  return { facets: await facets(getDb(), specFromQuery(req), sp.get('column') ?? '', sp.get('q')) };
});
