// GET jb/boards/:id/changes?since= (ARC-23, JB-1502): batches after `since`, or {resync} below compacted_seq (JB-1606).
import { changesSince } from '@/modules/jb/server/boards';
import { ApiError } from '@/server/http/errors';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/jb/boards/:id/changes', auth: 'required' }, async ({ req, principal, params }) => {
  const raw = new URL(req.url).searchParams.get('since');
  const since = Number(raw);
  if (raw === null || raw === '' || !Number.isSafeInteger(since) || since < 0) throw new ApiError('validation', 'since must be a whole number.', { field: 'since' });
  return changesSince(principal!, params.id, since);
});
