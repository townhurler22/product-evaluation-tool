// GET fh/board: kanban columns grouped by status, type, owner or Feature (FH-771–773).
import { requireMember } from '@/modules/fh/access';
import { specFromQuery } from '@/modules/fh/http';
import { BOARD_GROUPS, boardColumns, type BoardGroup } from '@/modules/fh/query';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/board', auth: 'required' }, async ({ req, principal }) => {
  requireMember(principal);
  const sp = req.nextUrl.searchParams;
  const group = sp.get('group') ?? 'status';
  if (!(BOARD_GROUPS as readonly string[]).includes(group)) throw new ApiError('validation', 'Group by status, type, owner or feature.', { field: 'group' });
  // `column` absent: first page of every column. `column=` (empty) is the "no value" column.
  const column = sp.has('column') ? (sp.get('column') || null) : undefined;
  return boardColumns(getDb(), specFromQuery(req), group as BoardGroup, column, sp.get('cursor'));
});
