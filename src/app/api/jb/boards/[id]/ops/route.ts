// POST jb/boards/:id/ops (JB-1601, JB-1602, PERF-25): editors only; all or nothing; idempotent by batchId.
import { applyBatch } from '@/modules/jb/server/batch';
import { BatchBody } from '@/modules/jb/wire';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/jb/boards/:id/ops', auth: 'required', body: BatchBody, maxBodyBytes: 2 * 1024 * 1024 },
  async ({ principal, params, body }) => applyBatch(principal!, params.id, body));
