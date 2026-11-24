// jb/boards/:id/comments/:threadId: reply (POST), resolve or unresolve (PATCH), delete (author, owner or manager).
import { z } from 'zod';
import { deleteThread, reply, setResolved } from '@/modules/jb/server/comments';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/jb/boards/:id/comments/:threadId', auth: 'required', body: z.strictObject({ body: z.string().min(1).max(4000) }) },
  async ({ principal, params, body }) => ({ thread: await reply(principal!, params.id, params.threadId, body.body) }));

export const PATCH = route({ route: 'PATCH /api/jb/boards/:id/comments/:threadId', auth: 'required', body: z.strictObject({ resolved: z.boolean() }) },
  async ({ principal, params, body }) => ({ thread: await setResolved(principal!, params.id, params.threadId, body.resolved) }));

export const DELETE = route({ route: 'DELETE /api/jb/boards/:id/comments/:threadId', auth: 'required' }, async ({ principal, params }) => {
  await deleteThread(principal!, params.id, params.threadId);
  return new Response(null, { status: 204 });
});
