// NFR-27, NFR-43: one round trip; fails if the schema is older than this build needs.
import { sql } from 'kysely';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { route } from '@/server/http/route';
import { REQUIRED_MIGRATION } from '@/server/schema-version';

export const dynamic = 'force-dynamic';

export const GET = route({ route: 'GET /api/readyz', auth: 'none' }, async () => {
  const r = await sql<{ id: string | null }>`SELECT max(id) AS id FROM core_schema_migration`.execute(getDb());
  const current = r.rows[0]?.id ?? '';
  if (current < REQUIRED_MIGRATION) {
    throw new ApiError('unavailable', 'Database schema is older than this build needs.', { current, required: REQUIRED_MIGRATION });
  }
  return { ok: true, schema: current };
});
