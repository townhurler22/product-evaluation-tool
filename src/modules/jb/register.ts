// Journey Boards registrations with Core: realtime channel rule, share resolver and manage policy,
// file owner resolver and jobs. Imported by src/server/registrations.ts (and therefore by every route that needs them).
import { sql } from 'kysely';
import {
  newId, registerChannelRule, registerFileOwnerResolver, registerJob, registerShareManagePolicy, registerShareResolver, sha256,
} from '@/modules/core/service';
import { getDb } from '@/server/db';
import { loadBoard } from './server/access';
import { readRows } from './server/boards';
import { resolveBoardShare } from './server/share';

// §3.7: jb.board.<id> → viewers of the board (a journey judged by its parent). One statement.
registerChannelRule('jb.board', async (principal, id) => {
  if (!id) return false;
  try { await loadBoard(principal, id); return true; } catch { return false; }
});

registerShareResolver('jb', resolveBoardShare);

// §11.2: board links are managed by the owner or a manager, judged with workspace edit off.
registerShareManagePolicy('jb', 'board', async (principal, targetId) => {
  try {
    const a = await loadBoard(principal, targetId);
    return a.rights.canManage && !a.row.journey_of_board_id;
  } catch { return false; }
});

// ARC-29: the nightly sweep asks whether file owners still exist.
registerFileOwnerResolver('jb', 'board', async (ids) => {
  if (!ids.length) return new Set();
  const rows = await getDb().selectFrom('jb_board').select('id').where('id', 'in', ids).execute();
  return new Set(rows.map((r) => r.id));
});

export const RETENTION_DAYS = 30; // OD-25
const SNAPSHOTS_KEPT = 10;

/**
 * JB-1606 nightly compaction: for each board with change rows older than 30 days, snapshot the live board,
 * remove those rows and tombstones older than 30 days, and raise compacted_seq. Idempotent.
 */
export async function compactBoards(now = new Date(), limit = 200): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  const boards = (await sql<{ board_id: string; max_seq: number }>`
    SELECT board_id, max(seq)::float8 AS max_seq FROM jb_change WHERE created_at < ${cutoff}
    GROUP BY board_id LIMIT ${limit}`.execute(getDb())).rows;
  for (const b of boards) {
    const rows = await readRows(getDb(), b.board_id);
    const head = await getDb().selectFrom('jb_board').select(['seq', 'name', 'settings']).where('id', '=', b.board_id).executeTakeFirst();
    if (!head) continue;
    const doc = { name: head.name, settings: head.settings, ...rows };
    const docJson = JSON.stringify(doc);
    await getDb().transaction().execute(async (tx) => {
      await sql`INSERT INTO jb_snapshot (board_id, seq, reason, doc, doc_hash) VALUES (${b.board_id}, ${head.seq}, 'compaction', ${docJson}::jsonb, ${sha256(docJson)})
        ON CONFLICT DO NOTHING`.execute(tx);
      await sql`DELETE FROM jb_change WHERE board_id = ${b.board_id} AND seq <= ${b.max_seq}`.execute(tx);
      for (const t of ['jb_node', 'jb_edge', 'jb_field']) {
        await sql`DELETE FROM ${sql.table(t)} WHERE board_id = ${b.board_id} AND deleted_at < ${cutoff}`.execute(tx);
      }
      await sql`UPDATE jb_board SET compacted_seq = greatest(compacted_seq, ${b.max_seq}) WHERE id = ${b.board_id}`.execute(tx);
      await sql`DELETE FROM jb_snapshot WHERE board_id = ${b.board_id} AND seq NOT IN (
        SELECT seq FROM jb_snapshot WHERE board_id = ${b.board_id} ORDER BY seq DESC LIMIT ${SNAPSHOTS_KEPT})`.execute(tx);
    });
  }
  return boards.length;
}

registerJob('jb.compact', async () => { await compactBoards(); });

void newId;
