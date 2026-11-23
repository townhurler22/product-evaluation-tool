// Called every minute by Supabase pg_cron (DECISIONS). Bearer secret, constant-time compare.
import { timingSafeEqual } from 'node:crypto';
import { drainJobs } from '@/modules/core/jobs';
import { ApiError } from '@/server/http/errors';
import { route } from '@/server/http/route';
import '@/server/jobs-registry';

function authorised(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const POST = route({ route: 'POST /api/internal/jobs/drain', auth: 'none' }, async ({ req }) => {
  if (!authorised(req.headers.get('authorization'))) throw new ApiError('not_found', 'Not found.');
  return drainJobs();
});
