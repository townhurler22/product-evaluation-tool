// jb/boards/:id/comments (§8.12): V read (optionally one thread), C create a pinned thread with its first message.
import { z } from 'zod';
import { createThread, listThreads } from '@/modules/jb/server/comments';
import { LocalId } from '@/modules/jb/wire';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/jb/boards/:id/comments', auth: 'required' }, async ({ req, principal, params }) =>
  ({ threads: await listThreads(principal!, params.id, new URL(req.url).searchParams.get('threadId') ?? undefined) }));

const Create = z.strictObject({
  anchorType: z.enum(['BOARD', 'NODE']), anchorNodeId: LocalId.nullish(),
  x: z.number().finite().min(-1e7).max(1e7), y: z.number().finite().min(-1e7).max(1e7), body: z.string().min(1).max(4000),
});

export const POST = route({ route: 'POST /api/jb/boards/:id/comments', auth: 'required', body: Create }, async ({ principal, params, body }) =>
  Response.json({ thread: await createThread(principal!, params.id, body) }, { status: 201 }));
