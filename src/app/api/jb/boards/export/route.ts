// POST jb/boards/export (JB-1901): V on each board; journeys come with their board; no comments or collaborators.
import { z } from 'zod';
import { exportBoards } from '@/modules/jb/server/boards';
import { BoardId } from '@/modules/jb/wire';
import { route } from '@/server/http/route';

const Body = z.strictObject({ boardIds: z.array(BoardId).min(1).max(20) });

export const POST = route({ route: 'POST /api/jb/boards/export', auth: 'required', body: Body }, async ({ principal, body }) =>
  Response.json(await exportBoards(principal!, body.boardIds), { headers: { 'Content-Disposition': 'attachment; filename="journey-boards.json"' } }));
