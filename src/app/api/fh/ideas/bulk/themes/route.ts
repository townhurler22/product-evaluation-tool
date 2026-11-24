// POST fh/ideas/bulk/themes (FH-153: add or remove one theme). 1–200 ids per request; the client chunks to the same cap.
import { requireAdmin } from '@/modules/fh/access';
import { bulkThemes } from '@/modules/fh/ideas';
import { BulkThemesBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/fh/ideas/bulk/themes', auth: 'required', body: BulkThemesBody }, async ({ principal, body }) => {
  requireAdmin(principal);
  return bulkThemes(principal, body.ids, body.themeId, body.action);
});
