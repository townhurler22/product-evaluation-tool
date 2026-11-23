import { z } from 'zod';
import { requireWorkspaceAdmin, updateUser } from '@/modules/core/admin';
import { route } from '@/server/http/route';

const Body = z.strictObject({
  role: z.enum(['ADMIN', 'PRODUCT', 'MEMBER']).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
}).refine((b) => b.role || b.status, { message: 'Change the role or the status.', path: ['role'] });

export const PATCH = route({ route: 'PATCH /api/core/admin/users/:id', auth: 'required', body: Body }, async ({ principal, params, body }) => {
  requireWorkspaceAdmin(principal);
  return { user: await updateUser(principal, params.id, body) };
});
