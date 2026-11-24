// GET jb/boards/:id/feature-search?q= (INT-43): from the 3rd character, up to 20 Features in tree order.
import { featureSearch } from '@/modules/jb/server/mapping';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/jb/boards/:id/feature-search', auth: 'required' }, async ({ req, principal, params }) =>
  featureSearch(principal!, params.id, (req.nextUrl.searchParams.get('q') ?? '').slice(0, 100)));
