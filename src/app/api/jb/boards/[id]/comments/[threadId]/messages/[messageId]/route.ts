// jb/boards/:id/comments/:threadId/messages/:messageId: edit one's own message; delete by author, owner or manager.
import { z } from 'zod';
import { deleteMessage, editMessage } from '@/modules/jb/server/comments';
import { route } from '@/server/http/route';

export const PATCH = route({ route: 'PATCH /api/jb/boards/:id/comments/:threadId/messages/:messageId', auth: 'required', body: z.strictObject({ body: z.string().min(1).max(4000) }) },
  async ({ principal, params, body }) => ({ thread: await editMessage(principal!, params.id, params.threadId, params.messageId, body.body) }));

export const DELETE = route({ route: 'DELETE /api/jb/boards/:id/comments/:threadId/messages/:messageId', auth: 'required' }, async ({ principal, params }) =>
  ({ thread: await deleteMessage(principal!, params.id, params.threadId, params.messageId) }));
