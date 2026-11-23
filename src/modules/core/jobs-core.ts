// Core's background jobs (§3.9).
import { sql } from 'kysely';
import { getDb } from '@/server/db';
import { sweepFiles } from './files/service';
import { registerJob } from './jobs';

registerJob('core.files.sweep', async () => { await sweepFiles(); });

/** NFR-29: sessions 30 days after expiry/revocation; share-link uses 90 days; rate windows 1 day; magic links 1 day. */
registerJob('core.retention', async () => {
  const db = getDb();
  await sql`DELETE FROM core_session WHERE coalesce(revoked_at, expires_at) < now() - interval '30 days'`.execute(db);
  await sql`DELETE FROM core_share_link_use WHERE created_at < now() - interval '90 days'`.execute(db);
  await sql`DELETE FROM core_rate_window WHERE window_start < now() - interval '1 day'`.execute(db);
  await sql`DELETE FROM core_magic_link WHERE created_at < now() - interval '1 day'`.execute(db);
  await sql`DELETE FROM core_job WHERE state = 'done' AND finished_at < now() - interval '7 days'`.execute(db);
});

/** Monthly: audit log beyond 24 months (OD-26) and intake log beyond 12 months (ING-36). */
registerJob('core.logs.prune', async () => {
  await getDb().transaction().execute(async (tx) => {
    await sql`SET LOCAL app.retention_job = 'on'`.execute(tx);
    await sql`DELETE FROM core_audit_log WHERE created_at < now() - interval '24 months'`.execute(tx);
  });
  await sql`DELETE FROM ing_log WHERE created_at < now() - interval '12 months'`.execute(getDb());
});
