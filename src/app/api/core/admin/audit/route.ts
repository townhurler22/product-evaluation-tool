import { listAudit, requireWorkspaceAdmin } from '@/modules/core/admin';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/core/admin/audit', auth: 'required' }, async ({ req, principal }) => {
  requireWorkspaceAdmin(principal);
  const sp = new URL(req.url).searchParams;
  return listAudit({
    actorId: sp.get('actorId') ?? undefined,
    action: sp.get('action') ?? undefined,
    targetId: sp.get('targetId') ?? undefined,
    before: sp.get('before') ?? undefined,
  });
});
