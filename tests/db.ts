// Fresh PostgreSQL (PGlite) per test file with every migration applied from empty (NFR-16).
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { migrate } from '../db/migrate';
import { setDb } from '@/server/db';
import { pgliteDialect } from '@/server/db/pglite-dialect';
import { clearPrincipalCache } from '@/modules/core/auth/principal';
import { clearSettingsCache } from '@/modules/core/settings';
import { discardAfterResponse } from '@/server/after';

export async function freshDb() {
  const pg = await PGlite.create({ extensions: { pg_trgm } });
  const applied = await migrate(pg);
  const db = setDb(pgliteDialect(pg));
  clearPrincipalCache();
  clearSettingsCache();
  discardAfterResponse();
  return { pg, db, applied };
}
