// PUT core/admin/users/:id/fh-grant (§11.2): feedback admin and post-delete grants. Workspace admins only.
import { z } from 'zod';
import { requireWorkspaceAdmin, setFhGrant } from '@/modules/core/admin';
import { route } from '@/server/http/route';

const Body = z.strictObject({ admin: z.boolean(), canDeletePosts: z.boolean() });

export const PUT = route({ route: 'PUT /api/core/admin/users/:id/fh-grant', auth: 'required', body: Body }, async ({ principal, params, body }) => {
  requireWorkspaceAdmin(principal);
  return { grant: await setFhGrant(principal, params.id, body) };
});
