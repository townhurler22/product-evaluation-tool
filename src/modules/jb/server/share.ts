// Board share links (JB-1401 to JB-1404, SEC-08, SEC-10, OD-24 (a)): read-only board and its journeys.
import { sql } from 'kysely';
import type { ResolvedTarget, ShareContext, ShareLinkRow } from '@/modules/core/service';
import { getDb } from '@/server/db';
import { canShareOutward, type CollaboratorRole } from '../rights';
import { readRows } from './boards';

/**
 * Fails closed: the board exists and is top-level, the creator is active, and the creator could still view
 * the board judged with workspace edit OFF (only the board's own people can share it outward). One statement.
 */
export async function resolveBoardShare(link: ShareLinkRow): Promise<ResolvedTarget | null> {
  if (link.module !== 'jb' || link.target_kind !== 'board' || link.creator_status !== 'ACTIVE') return null;
  const row = (await sql<{ owner_id: string; journey_of_board_id: string | null; creator_role: string; collab_role: CollaboratorRole | null; journey_ids: string[] }>`
    SELECT b.owner_id, b.journey_of_board_id, u.role AS creator_role, c.role AS collab_role,
           ARRAY(SELECT j.id FROM jb_board j WHERE j.journey_of_board_id = b.id ORDER BY j.created_at) AS journey_ids
    FROM jb_board b
    JOIN core_user u ON u.id = ${link.created_by}
    LEFT JOIN jb_collaborator c ON c.board_id = b.id AND c.user_id = ${link.created_by}
    WHERE b.id = ${link.target_id}`.execute(getDb())).rows[0];
  if (!row || row.journey_of_board_id) return null;
  const ok = canShareOutward({
    isWorkspaceAdmin: row.creator_role === 'ADMIN', isOwner: row.owner_id === link.created_by,
    collaboratorRole: row.collab_role, workspaceCanEdit: false,
  });
  return ok ? { targetId: link.target_id, grant: ['VIEW'], journeyIds: row.journey_ids } : null;
}

/** SEC-10: the requested board must be the link's board or one of its journeys. */
export const shareAllows = (share: ShareContext, boardId: string) => boardId === share.targetId || share.journeyIds.includes(boardId);

// Public types (INV-16): no owner, collaborator, comment or viewport data reaches a share response.
export interface PublicBoardMeta { id: string; name: string; journeyOfNodeId: string | null }

export async function shareBoardMetas(share: ShareContext): Promise<{ board: PublicBoardMeta; journeys: PublicBoardMeta[] }> {
  const ids = [share.targetId, ...share.journeyIds];
  const rows = await getDb().selectFrom('jb_board').select(['id', 'name', 'journey_of_node_id']).where('id', 'in', ids).execute();
  const pub = (r: (typeof rows)[number]) => ({ id: r.id, name: r.name, journeyOfNodeId: r.journey_of_node_id });
  return { board: pub(rows.find((r) => r.id === share.targetId)!), journeys: rows.filter((r) => r.id !== share.targetId).map(pub) };
}

export async function shareContent(share: ShareContext, boardId: string) {
  const head = await getDb().selectFrom('jb_board').select(['seq', 'settings']).where('id', '=', boardId).executeTakeFirstOrThrow();
  const rows = await readRows(getDb(), boardId);
  return { seq: Number(head.seq), settings: head.settings, ...rows };
}
