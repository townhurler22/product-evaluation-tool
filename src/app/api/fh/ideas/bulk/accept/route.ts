// POST fh/ideas/bulk/accept (FH-402: sets reviewed time, never changes status). 1–200 ids per request; the client chunks to the same cap.
import { requireAdmin } from '@/modules/fh/access';
import { bulkAccept } from '@/modules/fh/ideas';
import { BulkAcceptBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/fh/ideas/bulk/accept', auth: 'required', body: BulkAcceptBody }, async ({ principal, body }) => {
  requireAdmin(principal);
  return bulkAccept(principal, body.ids);
});
