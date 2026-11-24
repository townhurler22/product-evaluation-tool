// GET fh/people?q=: searchable, at most 50 rows (D-10). Management arrives in P2 (§7.14).
import { requireMember } from '@/modules/fh/access';
import { searchPeople } from '@/modules/fh/taxonomy';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/people', auth: 'required' }, async ({ req, principal }) => {
  requireMember(principal);
  return searchPeople(req.nextUrl.searchParams.get('q'));
});
