// Board access (§3.4 step 5, §8.13, D-23): one query over the lightweight board row and the viewer's
// collaborator row, cached per request. A journey is judged by its parent board.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Principal } from '@/modules/core/service';
import { currentContext, type RequestContext } from '@/server/context';
import { getDb, type DB } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { effectiveRights, type CollaboratorRole, type Rights } from '../rights';

export type Db = Kysely<DB> | Transaction<DB>;

export interface BoardRow {
  id: string;
  name: string;
  owner_id: string;               // root owner for a journey (JB-1303)
  journey_of_board_id: string | null;
  journey_of_node_id: string | null;
  workspace_can_edit: boolean;    // the root board's switch
  own_workspace_can_edit: boolean;
  collab_role: CollaboratorRole | null;
  seq: number;
  compacted_seq: number;
  min_client_protocol: number;
  live_node_count: number;
  created_at: Date;
  updated_at: Date;
  settings: Record<string, unknown> | null;
  viewport: { x: number; y: number; zoom: number } | null;
  /** P5 (D-27): bumped when the board's demand overlay may have changed. Absent on list rows. */
  demand_rev?: number;
}

export interface BoardAccess { row: BoardRow; rights: Rights }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cache = new WeakMap<RequestContext, Map<string, BoardAccess | null>>();

export const notFound = () => new ApiError('not_found', 'Not found.');
export const forbidden = (msg = 'You do not have permission to do that.') => new ApiError('forbidden', msg);

export function rightsFor(principal: Pick<Principal, 'userId' | 'isWorkspaceAdmin'>, row: Pick<BoardRow, 'owner_id' | 'collab_role' | 'workspace_can_edit'>): Rights {
  return effectiveRights({
    isWorkspaceAdmin: principal.isWorkspaceAdmin, isOwner: row.owner_id === principal.userId,
    collaboratorRole: row.collab_role, workspaceCanEdit: row.workspace_can_edit,
  });
}

/** Loads the board row and the viewer's rights. 404 for a missing board and for one the viewer may not view (JB-1305). */
export async function loadBoard(principal: Principal, boardId: string, db: Db = getDb()): Promise<BoardAccess> {
  if (!UUID_RE.test(boardId)) throw notFound();
  const ctx = currentContext();
  const key = `${principal.userId}:${boardId}`;
  let perReq = ctx ? cache.get(ctx) : undefined;
  if (ctx && !perReq) { perReq = new Map(); cache.set(ctx, perReq); }
  let hit = perReq?.get(key);
  if (hit === undefined) {
    const row = (await sql<BoardRow>`
      SELECT b.id, b.name, b.journey_of_board_id, b.journey_of_node_id,
             coalesce(p.owner_id, b.owner_id) AS owner_id,
             coalesce(p.workspace_can_edit, b.workspace_can_edit) AS workspace_can_edit,
             b.workspace_can_edit AS own_workspace_can_edit,
             c.role AS collab_role, b.seq::float8 AS seq, b.compacted_seq::float8 AS compacted_seq,
             b.min_client_protocol, b.live_node_count, b.created_at, b.updated_at, b.settings, b.viewport,
             b.demand_rev::float8 AS demand_rev
      FROM jb_board b
      LEFT JOIN jb_board p ON p.id = b.journey_of_board_id
      LEFT JOIN jb_collaborator c ON c.board_id = coalesce(b.journey_of_board_id, b.id) AND c.user_id = ${principal.userId}
      WHERE b.id = ${boardId}`.execute(db)).rows[0];
    hit = row ? { row, rights: rightsFor(principal, row) } : null;
    perReq?.set(key, hit);
  }
  if (!hit || !hit.rights.canView) throw notFound();
  return hit;
}

/** Forget cached access after a write that changes rights in this request. */
export function forgetAccess(principal: Principal, boardId: string) {
  const ctx = currentContext();
  if (ctx) cache.get(ctx)?.delete(`${principal.userId}:${boardId}`);
}

export async function requireEdit(principal: Principal, boardId: string, db?: Db) {
  const a = await loadBoard(principal, boardId, db);
  if (!a.rights.canEdit) throw forbidden('You can only view this board.');
  return a;
}
export async function requireComment(principal: Principal, boardId: string, db?: Db) {
  const a = await loadBoard(principal, boardId, db);
  if (!a.rights.canComment) throw forbidden('You cannot comment on this board.');
  return a;
}
export async function requireManage(principal: Principal, boardId: string, db?: Db) {
  const a = await loadBoard(principal, boardId, db);
  if (!a.rights.canManage) throw forbidden('Only the owner or a workspace admin can do that.');
  return a;
}

export interface BoardMeta {
  id: string; name: string; ownerId: string; ownerName: string | null;
  journeyOf: { boardId: string; nodeId: string } | null; workspaceCanEdit: boolean;
  nodeCount: number; journeyCount: number; createdAt: string; updatedAt: string;
  rights: { role: Rights['role']; canEdit: boolean; canComment: boolean; canManage: boolean };
}

export function toMeta(row: BoardRow, rights: Rights, extra: { ownerName?: string | null; journeyCount?: number } = {}): BoardMeta {
  return {
    id: row.id, name: row.name, ownerId: row.owner_id, ownerName: extra.ownerName ?? null,
    journeyOf: row.journey_of_board_id ? { boardId: row.journey_of_board_id, nodeId: row.journey_of_node_id! } : null,
    workspaceCanEdit: row.journey_of_board_id ? false : row.workspace_can_edit,
    nodeCount: row.live_node_count, journeyCount: extra.journeyCount ?? 0,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    rights: { role: rights.role, canEdit: rights.canEdit, canComment: rights.canComment, canManage: rights.canManage },
  };
}
