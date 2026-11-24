// Core's link service (ARC-06, §9.6, §11.4). Feedback Hub and Journey Boards read and write `core_link` only here.
// Every read takes a set and runs one statement (ARC-02); links are never deleted when an end goes (INT-26).
import { sql, type Kysely, type Transaction } from 'kysely';
import type { BoardLinks, Link, LinkModule, LinkRelation, NewLink } from '@pet/contracts';
import { getDb, type DB } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { newId } from './util';

type Db = Kysely<DB> | Transaction<DB>;

/** §9.6 / INT-31: who may write each relation. */
const WRITERS: Record<LinkRelation, LinkModule> = {
  'maps-to-feature': 'jb',
  'maps-to-journey': 'jb',
  'references-card': 'fh',
};

function assertWriter(caller: LinkModule, relation: LinkRelation) {
  if (WRITERS[relation] !== caller) throw new ApiError('forbidden', 'This module may not write that link.');
}

const j = (v: unknown) => JSON.stringify(v);
const textArray = (xs: string[]) => sql`ARRAY(SELECT jsonb_array_elements_text(${j(xs)}::jsonb))`;

interface LinkRow {
  id: string; relation: LinkRelation; from_module: string; from_kind: string; from_id: string; from_scope_id: string | null;
  to_module: string; to_kind: string; to_id: string; created_by: string | null; created_at: Date | string;
}
const LINK_COLS = sql`l.id, l.relation, l.from_module, l.from_kind, l.from_id, l.from_scope_id, l.to_module, l.to_kind, l.to_id, l.created_by, l.created_at`;
const toLink = (r: LinkRow): Link => ({
  id: r.id, relation: r.relation, fromModule: r.from_module, fromKind: r.from_kind, fromId: r.from_id, fromScopeId: r.from_scope_id,
  toModule: r.to_module, toKind: r.to_kind, toId: r.to_id, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(),
});
const moduleOf = (kind: string) => (kind === 'card' ? 'jb' : 'fh');

/**
 * PERF-30 step 2: the board's links and, with `includeJourneys`, its journeys' links, together with the boards in
 * scope and their live Product cards. One statement over `core_link (from_scope_id, relation)` and Journey Boards'
 * published views `jb_board_scope` and `jb_card_scope` (§6.7). Caps: 500 boards.
 */
export async function linksForBoard(input: { boardIds: string[]; includeJourneys: boolean; relations: LinkRelation[] }, db: Db = getDb()): Promise<BoardLinks> {
  const ids = [...new Set(input.boardIds)].slice(0, 500);
  if (!ids.length) return { scopes: [], cards: [], links: [] };
  const { rows } = await sql<{ scopes: unknown; cards: unknown; links: unknown }>`
    WITH scope AS (
      SELECT s.board_id, s.root_board_id, s.parent_node_id FROM jb_board_scope s
      WHERE s.board_id = ANY(${textArray(ids)})
         OR (${input.includeJourneys} AND coalesce(s.parent_node_id, '') <> '' AND s.root_board_id = ANY(${textArray(ids)})))
    SELECT
      coalesce((SELECT json_agg(json_build_object('boardId', board_id, 'rootBoardId', root_board_id, 'parentNodeId', parent_node_id)) FROM scope), '[]') AS scopes,
      coalesce((SELECT json_agg(json_build_object('cardId', c.card_id, 'boardId', c.board_id, 'nodeId', c.node_id, 'title', c.title) ORDER BY c.card_id)
        FROM jb_card_scope c WHERE c.board_id IN (SELECT board_id FROM scope)), '[]') AS cards,
      coalesce((SELECT json_agg(row_to_json(x) ORDER BY x.created_at, x.id) FROM (
        SELECT ${LINK_COLS} FROM core_link l
        WHERE l.from_scope_id IN (SELECT board_id FROM scope) AND l.relation = ANY(${textArray(input.relations)})) x), '[]') AS links`.execute(db);
  const r = rows[0];
  return { scopes: r.scopes as BoardLinks['scopes'], cards: r.cards as BoardLinks['cards'], links: (r.links as LinkRow[]).map(toLink) };
}

/** Links by their from end, for a set of ids. One statement. */
export async function listFrom(kind: string, ids: string[], relations?: LinkRelation[], db: Db = getDb()): Promise<Record<string, Link[]>> {
  const set = [...new Set(ids)].slice(0, 2000);
  if (!set.length) return {};
  const { rows } = await sql<LinkRow>`SELECT ${LINK_COLS} FROM core_link l
    WHERE l.from_kind = ${kind} AND l.from_id = ANY(${textArray(set)})
      AND (${relations ? textArray(relations) : null}::text[] IS NULL OR l.relation = ANY(${relations ? textArray(relations) : null}::text[]))
    ORDER BY l.created_at, l.id`.execute(db);
  const out: Record<string, Link[]> = {};
  for (const r of rows) (out[r.from_id] ??= []).push(toLink(r));
  return out;
}

/** Links by their to end (INT-31: "which cards link this Journey?"). One statement on `(to_kind, to_id, relation)`. */
export async function listTo(kind: string, ids: string[], relations?: LinkRelation[], db: Db = getDb()): Promise<Record<string, Link[]>> {
  const set = [...new Set(ids)].slice(0, 2000);
  if (!set.length) return {};
  const { rows } = await sql<LinkRow>`SELECT ${LINK_COLS} FROM core_link l
    WHERE l.to_kind = ${kind} AND l.to_id = ANY(${textArray(set)})
      AND (${relations ? textArray(relations) : null}::text[] IS NULL OR l.relation = ANY(${relations ? textArray(relations) : null}::text[]))
    ORDER BY l.created_at, l.id`.execute(db);
  const out: Record<string, Link[]> = {};
  for (const r of rows) (out[r.to_id] ??= []).push(toLink(r));
  return out;
}

/** Board ids holding a from end linked to any of these ids (for jb.demand.notify). One statement. */
export async function scopesLinkedTo(toKind: string, toIds: string[], db: Db = getDb()): Promise<string[]> {
  const set = [...new Set(toIds)];
  if (!set.length) return [];
  const { rows } = await sql<{ s: string }>`SELECT DISTINCT from_scope_id AS s FROM core_link
    WHERE to_kind = ${toKind} AND to_id = ANY(${textArray(set)}) AND from_scope_id IS NOT NULL`.execute(db);
  return rows.map((r) => r.s);
}

/** Idempotent create (INT-04): linking twice leaves one row. One statement. */
export async function createLink(caller: LinkModule, link: NewLink, actorId: string | null, db: Db = getDb()): Promise<{ created: boolean }> {
  assertWriter(caller, link.relation);
  const res = await sql`INSERT INTO core_link (id, relation, from_module, from_kind, from_id, from_scope_id, to_module, to_kind, to_id, created_by)
    VALUES (${newId()}, ${link.relation}, ${moduleOf(link.fromKind)}, ${link.fromKind}, ${link.fromId}, ${link.fromScopeId},
            ${moduleOf(link.toKind)}, ${link.toKind}, ${link.toId}, ${actorId})
    ON CONFLICT (relation, from_kind, from_id, to_kind, to_id) DO NOTHING`.execute(db);
  return { created: Number(res.numAffectedRows ?? 0) > 0 };
}

/** Idempotent remove. One statement. */
export async function removeLink(caller: LinkModule, link: Omit<NewLink, 'fromScopeId'>, db: Db = getDb()): Promise<{ removed: boolean }> {
  assertWriter(caller, link.relation);
  const res = await sql`DELETE FROM core_link WHERE relation = ${link.relation} AND from_kind = ${link.fromKind} AND from_id = ${link.fromId}
    AND to_kind = ${link.toKind} AND to_id = ${link.toId}`.execute(db);
  return { removed: Number(res.numAffectedRows ?? 0) > 0 };
}

/**
 * INT-17: replace every `relation` link from one end with exactly one link to `toId`, in one transaction.
 * Idempotent (INT-24). Two statements in their own transaction.
 */
export async function replaceFrom(caller: LinkModule, link: NewLink, actorId: string | null): Promise<{ removedToIds: string[] }> {
  assertWriter(caller, link.relation);
  return getDb().transaction().execute(async (tx) => {
    const del = await sql<{ to_id: string }>`DELETE FROM core_link WHERE relation = ${link.relation} AND from_kind = ${link.fromKind}
      AND from_id = ${link.fromId} AND NOT (to_kind = ${link.toKind} AND to_id = ${link.toId}) RETURNING to_id`.execute(tx);
    await createLink(caller, link, actorId, tx);
    return { removedToIds: del.rows.map((r) => r.to_id) };
  });
}
