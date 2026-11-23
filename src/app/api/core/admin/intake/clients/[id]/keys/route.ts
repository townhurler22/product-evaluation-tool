// ING-28: the secret appears in this one response and nowhere else.
import { requireWorkspaceAdmin } from '@/modules/core/admin';
import { issueKey } from '@/modules/core/intake/admin';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/core/admin/intake/clients/:id/keys', auth: 'required' }, async ({ req, principal, params }) => {
  requireWorkspaceAdmin(principal);
  const { keyId, secret } = await issueKey(principal.userId, params.id);
  const baseUrl = `${process.env.APP_ORIGIN ?? new URL(req.url).origin}/api/ingest/fh/v1/`;
  return Response.json({ keyId, secret, baseUrl }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
});
