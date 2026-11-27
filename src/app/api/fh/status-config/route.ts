// GET / PUT fh/status-config (FH-1105): which statuses the public forum shows, as what, and of which kind.
import { requireAdmin } from '@/modules/fh/access';
import { readStatusConfig, writeStatusConfig, type StatusConfigRow } from '@/modules/fh/forum-admin';
import { StatusConfigBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/status-config', auth: 'required' }, async ({ principal }) => {
  requireAdmin(principal);
  return { items: await readStatusConfig() };
});

export const PUT = route({ route: 'PUT /api/fh/status-config', auth: 'required', body: StatusConfigBody }, async ({ principal, body }) => {
  requireAdmin(principal);
  return { items: await writeStatusConfig(principal, body.items as StatusConfigRow[]) };
});
