// Journey Boards' public service interface (§11.4, ARC-01, ARC-02). Sets in, maps out.
import { sql } from 'kysely';
import type { Principal } from '@/modules/core/service';
import { getDb } from '@/server/db';
import { effectiveRights } from './rights';
export { resolveBoardShare } from './server/share';

export interface CardRef { boardId: string; nodeId: string; title: string; kind: string; boardName: string }

/**
 * resolveCards: `<boardId>:<nodeId>` ids → CardRef or "gone"; cards on boards the viewer cannot see are omitted.
 * 1 statement (≤ 500 ids).
 */
export async function resolveCards(viewer: Principal, cardIds: string[]): Promise<Record<string, CardRef | 'gone'>> {
  const ids = [...new Set(cardIds)].slice(0, 500).filter((c) => /^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(c));
  if (!ids.length) return {};
  const rows = (await sql<{ card_id: string; board_id: string | null; node_id: string | null; kind: string | null; title: string | null;
    board_name: string | null; owner_id: string | null; wce: boolean | null; collab_role: 'EDITOR' | 'COMMENTER' | 'VIEWER' | null; live: boolean }>`
    SELECT x.card_id, b.id AS board_id, n.id AS node_id, n.kind, n.data->>'title' AS title, b.name AS board_name,
           coalesce(p.owner_id, b.owner_id) AS owner_id, coalesce(p.workspace_can_edit, b.workspace_can_edit) AS wce,
           c.role AS collab_role, (n.id IS NOT NULL AND n.deleted_at IS NULL) AS live
    FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS x(card_id)
    LEFT JOIN jb_board b ON b.id = split_part(x.card_id, ':', 1)
    LEFT JOIN jb_board p ON p.id = b.journey_of_board_id
    LEFT JOIN jb_collaborator c ON c.board_id = coalesce(b.journey_of_board_id, b.id) AND c.user_id = ${viewer.userId}
    LEFT JOIN jb_node n ON n.board_id = b.id AND n.id = split_part(x.card_id, ':', 2)`.execute(getDb())).rows;
  const out: Record<string, CardRef | 'gone'> = {};
  for (const r of rows) {
    if (!r.board_id) { out[r.card_id] = 'gone'; continue; } // ARC-20: a deleted board's cards are gone
    const rights = effectiveRights({ isWorkspaceAdmin: viewer.isWorkspaceAdmin, isOwner: r.owner_id === viewer.userId, collaboratorRole: r.collab_role, workspaceCanEdit: Boolean(r.wce) });
    if (!rights.canView) continue;
    out[r.card_id] = r.live ? { boardId: r.board_id, nodeId: r.node_id!, title: r.title ?? '', kind: r.kind!, boardName: r.board_name! } : 'gone';
  }
  return out;
}

/** Boards hold no external people; kept so erasure stays complete if that changes (§11.4). 0 statements. */
export async function erasePerson(): Promise<{ counts: Record<string, number> }> { return { counts: {} }; }

/** 1 statement (≤ 1,000 ids). */
export async function fileOwnersExist(ownerKind: string, ownerIds: string[]): Promise<Set<string>> {
  if (ownerKind !== 'board' || !ownerIds.length) return new Set();
  const rows = await getDb().selectFrom('jb_board').select('id').where('id', 'in', ownerIds.slice(0, 1000)).execute();
  return new Set(rows.map((r) => r.id));
}
