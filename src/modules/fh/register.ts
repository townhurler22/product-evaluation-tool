// Feedback Hub's registrations with Core: the file owner resolver for intake screenshots (ARC-29, INV-17) and its
// part of erasure (SEC-20). Imported by the job registry and by src/server/registrations.ts.
import { sql } from 'kysely';
import { getDb } from '@/server/db';
import { registerErasureParticipant, registerFileOwnerResolver } from '@/modules/core/service';
import { erasePeople } from './people';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `fileOwnersExist('insight', ids)` for the nightly sweep. One statement per 1,000 ids. */
registerFileOwnerResolver('fh', 'insight', async (ownerIds) => {
  const ids = ownerIds.filter((x) => UUID_RE.test(x));
  if (!ids.length) return new Set();
  const { rows } = await sql<{ id: string }>`SELECT id::text FROM fh_insight WHERE id = ANY(${ids}::uuid[])`.execute(getDb());
  return new Set(rows.map((r) => r.id));
});

registerErasureParticipant('fh', erasePeople);
