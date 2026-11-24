// jb/boards/:id/collaborators (JB-1302): V read, O write, self remove. Audited; not ops.
import { z } from 'zod';
import { changeRole, inviteCollaborator, listCollaborators, removeCollaborator } from '@/modules/jb/server/collaborators';
import { ApiError } from '@/server/http/errors';
import { route } from '@/server/http/route';

const Role = z.enum(['EDITOR', 'COMMENTER', 'VIEWER']);

export const GET = route({ route: 'GET /api/jb/boards/:id/collaborators', auth: 'required' }, async ({ principal, params }) =>
  listCollaborators(principal!, params.id));

export const POST = route({ route: 'POST /api/jb/boards/:id/collaborators', auth: 'required',
  body: z.strictObject({ email: z.email().max(320), role: Role.default('EDITOR') }) },
async ({ principal, params, body }) => inviteCollaborator(principal!, params.id, body.email, body.role));

export const PATCH = route({ route: 'PATCH /api/jb/boards/:id/collaborators', auth: 'required',
  body: z.strictObject({ userId: z.uuid(), role: Role }) },
async ({ principal, params, body }) => changeRole(principal!, params.id, body.userId, body.role));

export const DELETE = route({ route: 'DELETE /api/jb/boards/:id/collaborators', auth: 'required' }, async ({ req, principal, params }) => {
  const userId = new URL(req.url).searchParams.get('userId') ?? '';
  if (!z.uuid().safeParse(userId).success) throw new ApiError('validation', 'userId is required.', { field: 'userId' });
  await removeCollaborator(principal!, params.id, userId);
  return new Response(null, { status: 204 });
});
