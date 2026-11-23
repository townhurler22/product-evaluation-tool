import { requireWorkspaceAdmin } from '@/modules/core/admin';
import { revokeKey } from '@/modules/core/intake/admin';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/core/admin/intake/clients/:id/keys/:keyId/revoke', auth: 'required' },
  async ({ principal, params }) => {
    requireWorkspaceAdmin(principal);
    await revokeKey(principal.userId, params.id, params.keyId);
    return { ok: true };
  });
