// GET fh/reporting (FH-851–854): tiles, theme trends, demand by Feature and refreshedAt, from fh_reporting_mv.
import { requireMember } from '@/modules/fh/access';
import { reporting } from '@/modules/fh/reporting';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/reporting', auth: 'required' }, async ({ principal }) => {
  requireMember(principal);
  return reporting();
});
