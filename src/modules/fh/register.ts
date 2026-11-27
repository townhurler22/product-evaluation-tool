// Feedback Hub's registrations with Core: file owner resolvers for intake and forum screenshots (ARC-29, INV-17),
// its part of erasure (SEC-20), and the forum share resolver and link policy (SEC-08, §11.2). Imported by the job
// registry and by src/server/registrations.ts.
import { sql } from 'kysely';
import { getDb } from '@/server/db';
import {
  registerErasureParticipant, registerFileOwnerResolver, registerShareCreateGuard, registerShareManagePolicy, registerShareResolver,
} from '@/modules/core/service';
import { ApiError } from '@/server/http/errors';
import { resolveForumShare } from './forum-public';
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

/** Forum screenshots (FH-1209): `post` owners for the nightly sweep. One statement per 1,000 ids. */
registerFileOwnerResolver('fh', 'post', async (ownerIds) => {
  const ids = ownerIds.filter((x) => UUID_RE.test(x));
  if (!ids.length) return new Set();
  const { rows } = await sql<{ id: string }>`SELECT id::text FROM fh_post WHERE id = ANY(${ids}::uuid[])`.execute(getDb());
  return new Set(rows.map((r) => r.id));
});

// SEC-08: a forum link works while the forum exists, is not archived, and its creator is an active feedback admin.
registerShareResolver('fh', resolveForumShare);

// §11.2: forum links are managed by feedback admins; the forum must exist. One statement.
registerShareManagePolicy('fh', 'forum', async (principal, targetId) => {
  if (!principal.isFeedbackAdmin || !UUID_RE.test(targetId)) return false;
  const { rows } = await sql<{ ok: boolean }>`SELECT true AS ok FROM fh_forum WHERE id = ${targetId}::uuid`.execute(getDb());
  return !!rows[0];
});

// FH-1104: links are refused for archived forums (409); existing links are kept and stop working (FH-1103).
registerShareCreateGuard('fh', 'forum', async (targetId) => {
  const { rows } = await sql<{ archived: boolean }>`SELECT is_archived AS archived FROM fh_forum WHERE id = ${targetId}::uuid`.execute(getDb());
  if (rows[0]?.archived) throw new ApiError('conflict', 'This forum is archived. Un-archive it to share it.');
});
