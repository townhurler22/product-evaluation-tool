// GET fh/lookups: Features, Journeys, themes, milestones, owners and settings in one request (§11.2).
import { requireMember } from '@/modules/fh/access';
import { lookups } from '@/modules/fh/taxonomy';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/lookups', auth: 'required' }, async ({ principal }) => {
  requireMember(principal);
  return lookups(principal);
});
