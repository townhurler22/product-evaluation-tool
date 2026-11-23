// Fixed-window rate limit shared across instances via core_rate_window (§6.1). One statement.
import { sql } from 'kysely';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';

export async function hit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const row = await getDb()
    .insertInto('core_rate_window')
    .values({ key, window_start: windowStart, count: 1 })
    .onConflict((oc) => oc.columns(['key', 'window_start']).doUpdateSet({ count: sql`core_rate_window.count + 1` }))
    .returning('count')
    .executeTakeFirstOrThrow();
  if (row.count > limit) {
    const retryAfter = Math.ceil((windowStart.getTime() + windowSeconds * 1000 - Date.now()) / 1000);
    throw new ApiError('rate_limited', 'Too many requests. Try again shortly.', { retryAfter });
  }
}
