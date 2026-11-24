// GET fh/journeys (FH-651). No create or rename here: only the Journey sync writes them (FH-652).
import { requireMember } from '@/modules/fh/access';
import { lookups } from '@/modules/fh/taxonomy';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/journeys', auth: 'required' }, async ({ principal }) => {
  requireMember(principal);
  return { journeys: (await lookups(principal)).journeys };
});
