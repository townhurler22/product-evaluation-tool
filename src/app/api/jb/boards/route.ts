// GET jb/boards (PERF-24, JB-102): metadata only. POST jb/boards: blank, sample template or a detailed journey.
import { z } from 'zod';
import { createBoard, listBoards } from '@/modules/jb/server/boards';
import { BoardId, LocalId } from '@/modules/jb/wire';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/jb/boards', auth: 'required' }, async ({ principal }) => ({ boards: await listBoards(principal!) }));

const Create = z.strictObject({
  id: BoardId.optional(),
  name: z.string().min(1).max(200),
  journeyOf: z.strictObject({ boardId: BoardId, nodeId: LocalId }).nullish(),
  template: z.enum(['blank', 'sample']).optional(),
});

export const POST = route({ route: 'POST /api/jb/boards', auth: 'required', body: Create }, async ({ principal, body }) =>
  Response.json(await createBoard(principal!, body), { status: 201 }));
