// POST fh/ideas/export: streamed CSV of the selected ids or every filtered row (FH-156, FH-157).
import { z } from 'zod';
import { Uuid, ViewSpecSchema } from '@/modules/fh/columns';
import { requireMember } from '@/modules/fh/access';
import { EXPORT_MAX_ROWS } from '@/modules/fh/domain';
import { exportCsv } from '@/modules/fh/export';
import { route } from '@/server/http/route';

const Body = z.strictObject({
  viewSpec: ViewSpecSchema,
  ids: z.array(Uuid).min(1).max(EXPORT_MAX_ROWS).optional(),
  columns: z.array(z.string().max(40)).min(1).max(60),
});

// Members may export (§12.1 assumption, OD-06: visible columns only, no emails).
export const POST = route({ route: 'POST /api/fh/ideas/export', auth: 'required', body: Body, maxBodyBytes: 2 * 1024 * 1024 }, async ({ principal, body }) => {
  requireMember(principal);
  return exportCsv(principal, body.viewSpec, body.columns, body.ids ?? null);
});
