// Collaborators (JB-1302, JB-1304). Audited; not ops. Rights changes go out as board.meta (JB-1306).
import { sql } from 'kysely';
import { audit, type Principal } from '@/modules/core/service';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import type { CollaboratorRole } from '../rights';
import { forbidden, loadBoard, notFound, requireManage } from './access';
import { boardChannel, emit } from './events';

export interface Collaborator { userId: string; email: string; name: string | null; role: CollaboratorRole }

const rootOf = (row: { id: string; journey_of_board_id: string | null }) => row.journey_of_board_id ?? row.id;

export async function listCollaborators(principal: Principal, boardId: string) {
  const a = await loadBoard(principal, boardId);
  const rows = (await sql<Collaborator>`
    SELECT c.user_id AS "userId", u.email, u.full_name AS name, c.role FROM jb_collaborator c JOIN core_user u ON u.id = c.user_id
    WHERE c.board_id = ${rootOf(a.row)} ORDER BY u.email`.execute(getDb())).rows;
  const owner = await getDb().selectFrom('core_user').select(['id', 'email', 'full_name']).where('id', '=', a.row.owner_id).executeTakeFirst();
  return { owner: owner ? { userId: owner.id, email: owner.email, name: owner.full_name } : null, collaborators: rows };
}

export async function inviteCollaborator(principal: Principal, boardId: string, email: string, role: CollaboratorRole) {
  const a = await requireManage(principal, boardId);
  if (a.row.journey_of_board_id) throw new ApiError('rule_violation', 'Share the parent board; its journeys follow it.');
  const user = await getDb().selectFrom('core_user').select(['id', 'status']).where('email', '=', email.trim().toLowerCase()).executeTakeFirst();
  if (!user || user.status !== 'ACTIVE') throw new ApiError('rule_violation', 'Invite someone who already has an active account.');
  if (user.id === a.row.owner_id) throw new ApiError('rule_violation', 'The owner already has full access.');
  await getDb().insertInto('jb_collaborator').values({ board_id: boardId, user_id: user.id, role, added_by: principal.userId })
    .onConflict((oc) => oc.columns(['board_id', 'user_id']).doUpdateSet({ role })).execute(); // re-inviting changes the role
  await audit({ actorKind: 'user', actorId: principal.userId, action: 'jb.collaborator.set', targetKind: 'board', targetId: boardId, details: { userId: user.id, role } });
  emit(boardChannel(boardId), 'board.meta', { rightsChanged: true });
  return { userId: user.id, role };
}

export async function changeRole(principal: Principal, boardId: string, userId: string, role: CollaboratorRole) {
  await requireManage(principal, boardId);
  const r = await getDb().updateTable('jb_collaborator').set({ role }).where('board_id', '=', boardId).where('user_id', '=', userId).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw notFound();
  await audit({ actorKind: 'user', actorId: principal.userId, action: 'jb.collaborator.set', targetKind: 'board', targetId: boardId, details: { userId, role } });
  emit(boardChannel(boardId), 'board.meta', { rightsChanged: true });
  return { userId, role };
}

/** Owners and managers remove anyone; any collaborator may remove themselves. */
export async function removeCollaborator(principal: Principal, boardId: string, userId: string) {
  const a = await loadBoard(principal, boardId);
  if (userId !== principal.userId && !a.rights.canManage) throw forbidden('Only the owner or a workspace admin can remove collaborators.');
  const r = await getDb().deleteFrom('jb_collaborator').where('board_id', '=', rootOf(a.row)).where('user_id', '=', userId).executeTakeFirst();
  if (!Number(r.numDeletedRows)) throw notFound();
  await audit({ actorKind: 'user', actorId: principal.userId, action: 'jb.collaborator.remove', targetKind: 'board', targetId: boardId, details: { userId } });
  emit(boardChannel(boardId), 'board.meta', { rightsChanged: true });
}

/** JB-1304: transfer ownership to another active user (journeys follow their parent). */
export async function transferOwnership(principal: Principal, boardId: string, userId: string) {
  const a = await requireManage(principal, boardId);
  if (a.row.journey_of_board_id) throw new ApiError('rule_violation', 'A journey\'s owner is its parent board\'s owner.');
  const user = await getDb().selectFrom('core_user').select('status').where('id', '=', userId).executeTakeFirst();
  if (!user || user.status !== 'ACTIVE') throw new ApiError('rule_violation', 'Choose an active user.');
  await getDb().updateTable('jb_board').set({ owner_id: userId }).where((eb) => eb.or([eb('id', '=', boardId), eb('journey_of_board_id', '=', boardId)])).execute();
  await audit({ actorKind: 'user', actorId: principal.userId, action: 'jb.board.transfer', targetKind: 'board', targetId: boardId, details: { userId } });
  emit(boardChannel(boardId), 'board.meta', { rightsChanged: true });
}
