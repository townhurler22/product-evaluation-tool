// PATCH jb/boards/:id/access (JB-1303): owner or manager; not for a journey.
import { z } from 'zod';
import { setWorkspaceEdit } from '@/modules/jb/server/boards';
import { route } from '@/server/http/route';

const Body = z.strictObject({ workspaceCanEdit: z.boolean() });

export const PATCH = route({ route: 'PATCH /api/jb/boards/:id/access', auth: 'required', body: Body }, async ({ principal, params, body }) =>
  setWorkspaceEdit(principal!, params.id, body.workspaceCanEdit));
