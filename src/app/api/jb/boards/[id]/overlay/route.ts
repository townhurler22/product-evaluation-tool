// GET jb/boards/:id/overlay?scope=open|all (PERF-30, INT-33): counts, release dates and attention flags for every
// Product card on the board in at most 4 statements, whatever the number of cards (PERF-B16, D-18).
import { overlay, parseScope } from '@/modules/jb/server/mapping';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/jb/boards/:id/overlay', auth: 'required' }, async ({ req, principal, params }) =>
  overlay(principal!, params.id, parseScope(req.nextUrl.searchParams.get('scope'))));
