// POST fh/ideas/bulk/status (FH-304: each idea through the FH-301 rules). 1–200 ids per request; the client chunks to the same cap.
import { requireAdmin } from '@/modules/fh/access';
import type { StatusKey } from '@/modules/fh/domain';
import { bulkStatus } from '@/modules/fh/ideas';
import { BulkStatusBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/fh/ideas/bulk/status', auth: 'required', body: BulkStatusBody }, async ({ principal, body }) => {
  requireAdmin(principal);
  return bulkStatus(principal, body.ids, body.status as StatusKey, body.comment);
});
