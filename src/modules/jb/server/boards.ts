// Boards: metadata list (PERF-24), create (blank, template, import, journey), content, changes,
// viewport, workspace edit, delete, export (§8.1, §8.13, §8.19, JB-1606).
import { sql, type Transaction } from 'kysely';
import { audit, deleteFiles, newId, type Principal } from '@/modules/core/service';
import { getDb, type DB } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { cleanText } from '@/lib/text';
import { isRegisteredKind } from '../kinds';
import type { EdgeRec, FieldRec, NodeRec } from '../ops';
import { sampleTemplate, statusField } from '../template';
import { EXPORT_FORMAT, EXPORT_SCHEMA_VERSION, type ExportBoardT, type ExportDocT } from '../wire';
import { forbidden, loadBoard, notFound, requireEdit, requireManage, rightsFor, toMeta, type BoardMeta, type BoardRow, type Db } from './access';
import { boardChannel, emit } from './events';

const j = (v: unknown) => JSON.stringify(v);
const textArray = (xs: string[]) => sql`ARRAY(SELECT jsonb_array_elements_text(${j(xs)}::jsonb))`;

// ── list (JB-101, JB-102, PERF-24): metadata only, 1 statement ─────────────
export async function listBoards(principal: Principal): Promise<BoardMeta[]> {
  const rows = (await sql<BoardRow & { owner_name: string | null; journey_count: number }>`
    SELECT b.id, b.name, b.owner_id, u.full_name AS owner_name, NULL AS journey_of_board_id, NULL AS journey_of_node_id,
           b.workspace_can_edit, b.workspace_can_edit AS own_workspace_can_edit, c.role AS collab_role,
           b.seq::float8 AS seq, b.compacted_seq::float8 AS compacted_seq, b.min_client_protocol, b.live_node_count,
           b.created_at, b.updated_at, NULL::jsonb AS settings, NULL::jsonb AS viewport,
           (SELECT count(*)::int FROM jb_board j WHERE j.journey_of_board_id = b.id) AS journey_count
    FROM jb_board b
    JOIN core_user u ON u.id = b.owner_id
    LEFT JOIN jb_collaborator c ON c.board_id = b.id AND c.user_id = ${principal.userId}
    WHERE b.journey_of_board_id IS NULL
      AND (${principal.isWorkspaceAdmin} OR b.owner_id = ${principal.userId} OR b.workspace_can_edit OR c.role IS NOT NULL)
    ORDER BY b.created_at, b.id`.execute(getDb())).rows;
  return rows.map((r) => toMeta(r, rightsFor(principal, r), { ownerName: r.owner_name, journeyCount: r.journey_count }));
}

// ── content (PERF-24): access row, nodes, edges, fields; no tombstones (D-22) ──
export interface BoardContent {
  seq: number; name: string; settings: Record<string, unknown>; viewport: { x: number; y: number; zoom: number } | null;
  nodes: NodeRec[]; edges: EdgeRec[]; fields: FieldRec[];
}

export async function readRows(db: Db, boardId: string) {
  const nodes = (await sql<NodeRec>`
    SELECT id, kind, x, y, width, height, z_index AS "zIndex", sort_key AS "sortKey", data, version
    FROM jb_node WHERE board_id = ${boardId} AND deleted_at IS NULL ORDER BY sort_key, id`.execute(db)).rows;
  const edges = (await sql<EdgeRec>`
    SELECT id, source_id AS source, target_id AS target, sort_key AS "sortKey", data, version
    FROM jb_edge WHERE board_id = ${boardId} AND deleted_at IS NULL ORDER BY sort_key, id`.execute(db)).rows;
  const fields = (await sql<FieldRec>`
    SELECT id, kind, label, options, show_on_card AS "showOnCard", sort_key AS "sortKey", preset_key AS "presetKey", extra, version
    FROM jb_field WHERE board_id = ${boardId} AND deleted_at IS NULL ORDER BY sort_key, id`.execute(db)).rows;
  return { nodes, edges, fields };
}

export async function boardContent(principal: Principal, boardId: string): Promise<{ meta: BoardMeta; content: BoardContent }> {
  // Repeatable read so seq and rows are one consistent snapshot. 4 statements (access, nodes, edges, fields).
  return getDb().transaction().setIsolationLevel('repeatable read').execute(async (tx) => {
    const a = await loadBoard(principal, boardId, tx);
    const rows = await readRows(tx, boardId);
    return { a, rows };
  }).then(async ({ a, rows }) => ({
    meta: toMeta(a.row, a.rights),
    content: { seq: a.row.seq, name: a.row.name, settings: a.row.settings ?? {}, viewport: a.row.viewport ?? null, ...rows },
  }));
}

// ── changes since (ARC-23, JB-1502, JB-1606) ───────────────────────────────
export interface ChangeBatch { seq: number; batchId: string; clientId: string; userId: string | null; ops: unknown[]; results: unknown[] }
export const CHANGES_PAGE = 200;

export async function changesSince(principal: Principal, boardId: string, since: number) {
  const a = await loadBoard(principal, boardId);
  // D-27: the demand revision rides on the poll every board already makes, so attention flags and demand changes
  // reach boards without realtime within the polling interval (the client refetches the overlay when it moves).
  const demandRev = a.row.demand_rev ?? 0;
  if (since < a.row.compacted_seq) return { resync: true as const, seq: a.row.seq, demandRev };
  if (since >= a.row.seq) return { seq: a.row.seq, batches: [] as ChangeBatch[], more: false, demandRev };
  const rows = (await sql<{ seq: number; batch_id: string; client_id: string; user_id: string | null; ops: unknown[]; result: { results: unknown[] } }>`
    SELECT seq::float8 AS seq, batch_id, client_id, user_id, ops, result FROM jb_change
    WHERE board_id = ${boardId} AND seq > ${since} ORDER BY seq LIMIT ${CHANGES_PAGE + 1}`.execute(getDb())).rows;
  const more = rows.length > CHANGES_PAGE;
  const page = rows.slice(0, CHANGES_PAGE);
  return {
    seq: page.length ? page[page.length - 1].seq : a.row.seq,
    more,
    demandRev,
    batches: page.map((r) => ({ seq: r.seq, batchId: r.batch_id, clientId: r.client_id, userId: r.user_id, ops: r.ops, results: r.result.results })),
  };
}

// ── create ─────────────────────────────────────────────────────────────────
interface NewBoardContent {
  fields: (Omit<FieldRec, 'version'>)[];
  nodes: (Omit<NodeRec, 'version'> & { parentId?: string | null })[];
  edges: (Omit<EdgeRec, 'version'>)[];
  settings: Record<string, unknown>;
}

type NewBoard = { id: string; name: string; journeyOf?: { boardId: string; nodeId: string } | null; workspaceCanEdit: boolean; content: NewBoardContent };

/** Inserts boards (parents before journeys) with their content in 4 statements, whatever the count. */
async function insertBoards(tx: Transaction<DB>, principal: Principal, boards: NewBoard[]) {
  await tx.insertInto('jb_board').values(boards.map((b) => ({
    id: b.id, name: b.name, owner_id: principal.userId, journey_of_board_id: b.journeyOf?.boardId ?? null,
    journey_of_node_id: b.journeyOf?.nodeId ?? null, workspace_can_edit: b.journeyOf ? false : b.workspaceCanEdit,
    settings: j(b.content.settings), live_node_count: b.content.nodes.length, live_edge_count: b.content.edges.length,
    live_field_count: b.content.fields.length, updated_by: principal.userId,
  }))).execute();
  const fields = boards.flatMap((b) => b.content.fields.map((f) => ({ ...f, boardId: b.id })));
  const nodes = boards.flatMap((b) => b.content.nodes.map((n) => ({ ...n, boardId: b.id,
    parentId: typeof n.data.parentId === 'string' && n.data.parentId ? n.data.parentId : null })));
  const edges = boards.flatMap((b) => b.content.edges.map((e) => ({ ...e, boardId: b.id })));
  if (fields.length) {
    await sql`INSERT INTO jb_field (board_id, id, kind, label, options, show_on_card, sort_key, preset_key, extra, last_seq)
      SELECT v."boardId", v.id, v.kind, v.label, v.options, v."showOnCard", v."sortKey", v."presetKey", coalesce(v.extra, '{}'::jsonb), 0
      FROM jsonb_to_recordset(${j(fields)}::jsonb) AS v("boardId" text, id text, kind text, label text, options jsonb, "showOnCard" bool, "sortKey" text, "presetKey" text, extra jsonb)`.execute(tx);
  }
  if (nodes.length) {
    await sql`INSERT INTO jb_node (board_id, id, kind, x, y, width, height, z_index, parent_id, sort_key, data, last_seq)
      SELECT v."boardId", v.id, v.kind, v.x, v.y, v.width, v.height, v."zIndex", v."parentId", v."sortKey", v.data, 0
      FROM jsonb_to_recordset(${j(nodes)}::jsonb) AS v("boardId" text, id text, kind text, x float8, y float8, width float8, height float8, "zIndex" int, "parentId" text, "sortKey" text, data jsonb)`.execute(tx);
  }
  if (edges.length) {
    await sql`INSERT INTO jb_edge (board_id, id, source_id, target_id, sort_key, data, last_seq)
      SELECT v."boardId", v.id, v.source, v.target, v."sortKey", coalesce(v.data, '{}'::jsonb), 0
      FROM jsonb_to_recordset(${j(edges)}::jsonb) AS v("boardId" text, id text, source text, target text, "sortKey" text, data jsonb)`.execute(tx);
  }
}

export interface CreateBoardInput { id?: string; name: string; journeyOf?: { boardId: string; nodeId: string } | null; template?: 'blank' | 'sample' }

export async function createBoard(principal: Principal, input: CreateBoardInput) {
  const name = cleanText(input.name, 200);
  if (!name) throw new ApiError('validation', 'A board needs a name.', { field: 'name' });
  const id = input.id ?? newId();
  if (input.journeyOf) {
    // A detailed journey: E on the parent, parent top-level, card live and a Product card (§11.2, INV-21).
    const parent = await requireEdit(principal, input.journeyOf.boardId);
    if (parent.row.journey_of_board_id) throw new ApiError('rule_violation', 'A detailed journey cannot have its own journey.');
    const card = await getDb().selectFrom('jb_node').select('kind').where('board_id', '=', input.journeyOf.boardId)
      .where('id', '=', input.journeyOf.nodeId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!card || card.kind !== 'product-card') throw new ApiError('rule_violation', 'Only a Product card can own a detailed journey.');
  }
  const content: NewBoardContent = input.template === 'sample'
    ? sampleTemplate(new Date())
    : { fields: [statusField()], nodes: [], edges: [], settings: {} };
  try {
    await getDb().transaction().execute((tx) => insertBoards(tx, principal, [{
      id, name, journeyOf: input.journeyOf ?? null,
      workspaceCanEdit: input.template === 'sample', // OD-23: new boards off; the sample template board starts on
      content,
    }]));
  } catch (e) {
    const pg = e as { code?: string };
    if (pg.code === '23505') throw new ApiError('conflict', input.journeyOf ? 'This card already has a detailed journey.' : 'A board with this id already exists.');
    throw e;
  }
  const out = await boardContent(principal, id);
  if (!input.journeyOf) emit('jb.workspace', 'board.created', { meta: { id, name } });
  return out;
}

// ── viewport (JB-106): editors only; not an op; never moves updated_at ─────
export async function saveViewport(principal: Principal, boardId: string, v: { x: number; y: number; zoom: number }) {
  await requireEdit(principal, boardId);
  await getDb().updateTable('jb_board').set({ viewport: j(v) }).where('id', '=', boardId).execute();
}

// ── workspace edit (JB-1303): owner or manager, top-level only; audited; not an op ──
export async function setWorkspaceEdit(principal: Principal, boardId: string, on: boolean) {
  const a = await requireManage(principal, boardId);
  if (a.row.journey_of_board_id) throw new ApiError('rule_violation', 'A detailed journey follows its parent board.');
  await getDb().updateTable('jb_board').set({ workspace_can_edit: on }).where('id', '=', boardId).execute();
  await audit({ actorKind: 'user', actorId: principal.userId, action: 'jb.board.workspace_edit', targetKind: 'board', targetId: boardId, details: { on } });
  emit(boardChannel(boardId), 'board.meta', { rightsChanged: true });
  return { workspaceCanEdit: on };
}

// ── delete (JB-104, ARC-29) ────────────────────────────────────────────────
export async function deleteBoard(principal: Principal, boardId: string) {
  const a = await requireManage(principal, boardId);
  const fileIds = await getDb().transaction().execute(async (tx) => {
    const files = (await sql<{ file_id: string }>`
      SELECT i.file_id FROM jb_image i JOIN jb_board b ON b.id = i.board_id
      WHERE b.id = ${boardId} OR b.journey_of_board_id = ${boardId}`.execute(tx)).rows.map((r) => r.file_id);
    await tx.deleteFrom('jb_board').where('id', '=', boardId).execute(); // cascades journeys, content, comments, collaborators, images
    await audit({ actorKind: 'user', actorId: principal.userId, action: 'jb.board.delete', targetKind: 'board', targetId: boardId,
      details: { files: files.length } }, tx);
    return files;
  });
  // Files go after the owner's rows commit; a storage failure marks them for the nightly retry (ARC-29).
  if (fileIds.length) await deleteFiles(fileIds);
  if (!a.row.journey_of_board_id) emit('jb.workspace', 'board.deleted', { meta: { id: boardId } });
  emit(boardChannel(boardId), 'board.locked', { reason: 'deleted' });
}

// ── export / import (JB-1901, JB-1902): comments and collaborators never exported ──
export async function exportBoards(principal: Principal, boardIds: string[]): Promise<ExportDocT> {
  // Fixed statements whatever the number of boards (≤ 20): access for all, board heads, nodes, edges, fields.
  const ids = [...new Set(boardIds)];
  const heads = (await sql<BoardRow & { root_id: string }>`
    SELECT b.id, b.name, b.journey_of_board_id, b.journey_of_node_id, b.settings, coalesce(b.journey_of_board_id, b.id) AS root_id,
           coalesce(p.owner_id, b.owner_id) AS owner_id, coalesce(p.workspace_can_edit, b.workspace_can_edit) AS workspace_can_edit, c.role AS collab_role
    FROM jb_board b
    LEFT JOIN jb_board p ON p.id = b.journey_of_board_id
    LEFT JOIN jb_collaborator c ON c.board_id = coalesce(b.journey_of_board_id, b.id) AND c.user_id = ${principal.userId}
    WHERE b.id = ANY(${textArray(ids)}) OR b.journey_of_board_id = ANY(${textArray(ids)})
    ORDER BY b.created_at, b.id`.execute(getDb())).rows;
  for (const id of ids) {
    const h = heads.find((x) => x.id === id);
    if (!h || !rightsFor(principal, h).canView) throw notFound();
    if (h.journey_of_board_id) throw new ApiError('rule_violation', 'Export the top-level board; its journeys come with it.');
  }
  const all = heads.map((h) => h.id);
  const nodes = (await sql<NodeRec & { board_id: string }>`
    SELECT board_id, id, kind, x, y, width, height, z_index AS "zIndex", sort_key AS "sortKey", data
    FROM jb_node WHERE board_id = ANY(${textArray(all)}) AND deleted_at IS NULL ORDER BY sort_key, id`.execute(getDb())).rows;
  const edges = (await sql<EdgeRec & { board_id: string }>`
    SELECT board_id, id, source_id AS source, target_id AS target, sort_key AS "sortKey", data
    FROM jb_edge WHERE board_id = ANY(${textArray(all)}) AND deleted_at IS NULL ORDER BY sort_key, id`.execute(getDb())).rows;
  const fields = (await sql<FieldRec & { board_id: string }>`
    SELECT board_id, id, kind, label, options, show_on_card AS "showOnCard", sort_key AS "sortKey", preset_key AS "presetKey", extra
    FROM jb_field WHERE board_id = ANY(${textArray(all)}) AND deleted_at IS NULL ORDER BY sort_key, id`.execute(getDb())).rows;
  const strip = <T extends { board_id: string }>(r: T) => { const { board_id: _b, ...rest } = r; void _b; return rest; };
  const part = (h: BoardRow) => ({
    name: h.name, settings: h.settings ?? {},
    nodes: nodes.filter((n) => n.board_id === h.id).map(strip), edges: edges.filter((e) => e.board_id === h.id).map(strip),
    fields: fields.filter((f) => f.board_id === h.id).map(strip),
  });
  const boards = ids.map((id) => {
    const h = heads.find((x) => x.id === id)!;
    return { ...part(h), journeys: heads.filter((x) => x.journey_of_board_id === id).map((jy) => ({ ...part(jy), journeyOfNodeId: jy.journey_of_node_id! })) };
  });
  return { format: EXPORT_FORMAT, schemaVersion: EXPORT_SCHEMA_VERSION, boards } as ExportDocT;
}

function importContent(b: Omit<ExportBoardT, 'journeys'>, path: string): NewBoardContent {
  for (const [i, n] of b.nodes.entries()) if (!isRegisteredKind(n.kind)) throw new ApiError('validation', 'Unknown card type', { field: `${path}.nodes.${i}.kind` });
  const ids = new Set(b.nodes.map((n) => n.id));
  for (const [i, e] of b.edges.entries()) {
    if (!ids.has(e.source) || !ids.has(e.target)) throw new ApiError('validation', 'A connector must join two cards on its board.', { field: `${path}.edges.${i}` });
  }
  const fields = b.fields.map((f) => ({ id: f.id, kind: f.kind, label: f.label, options: f.options ?? [], showOnCard: f.showOnCard ?? false,
    sortKey: f.sortKey, presetKey: f.presetKey ?? null, extra: f.extra ?? {} }));
  if (!fields.some((f) => f.presetKey === 'status')) fields.unshift(statusField('0V'));
  return {
    settings: b.settings ?? {}, fields,
    nodes: b.nodes.map((n) => ({ id: n.id, kind: n.kind, x: n.x, y: n.y, width: n.width ?? null, height: n.height ?? null, zIndex: n.zIndex ?? null, sortKey: n.sortKey, data: n.data })),
    edges: b.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sortKey: e.sortKey, data: e.data ?? {} })),
  };
}

/** Creates NEW boards with new ids; never overwrites (JB-1902). Unknown keys in data survive. */
export async function importBoards(principal: Principal, doc: ExportDocT): Promise<BoardMeta[]> {
  const plan = doc.boards.map((b, i) => ({
    id: newId(), name: b.name, content: importContent(b, `boards.${i}`),
    journeys: (b.journeys ?? []).map((jy, k) => ({ id: newId(), name: jy.name, nodeId: jy.journeyOfNodeId, content: importContent(jy, `boards.${i}.journeys.${k}`) })),
  }));
  for (const [i, p] of plan.entries()) {
    for (const [k, jy] of p.journeys.entries()) {
      const card = p.content.nodes.find((n) => n.id === jy.nodeId);
      if (!card || card.kind !== 'product-card') throw new ApiError('validation', 'A detailed journey must belong to a Product card.', { field: `boards.${i}.journeys.${k}.journeyOfNodeId` });
    }
  }
  await getDb().transaction().execute(async (tx) => {
    // Parents first so the journey guard trigger sees them; one multi-row insert per table.
    await insertBoards(tx, principal, plan.map((p) => ({ id: p.id, name: p.name, workspaceCanEdit: false, content: p.content })));
    const journeys = plan.flatMap((p) => p.journeys.map((jy) => ({ id: jy.id, name: jy.name, journeyOf: { boardId: p.id, nodeId: jy.nodeId }, workspaceCanEdit: false, content: jy.content })));
    if (journeys.length) await insertBoards(tx, principal, journeys);
  });
  const all = await listBoards(principal);
  const ids = new Set(plan.map((p) => p.id));
  for (const p of plan) emit('jb.workspace', 'board.created', { meta: { id: p.id, name: p.name } });
  return all.filter((m) => ids.has(m.id));
}

export { forbidden, notFound };
