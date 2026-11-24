// POST boards/:id/ops (JB-1601, JB-1602, PERF-25, INV-19, INV-20, INV-22).
// Set-based: a fixed number of statements per batch, independent of board size (PT-13):
//   1 lock + replay check · ≤ 2 per table (insert creates, update the rest) · ≤ 1 integrity · 1 change row + counters.
import { sql, type Transaction } from 'kysely';
import type { Principal } from '@/modules/core/service';
import { getDb, type DB } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { cleanText, TextTooLong } from '@/lib/text';
import { getKind, isRegisteredKind } from '../kinds';
import {
  CAPS, CLIENT_PROTOCOL, mergeData, SET_COLUMNS, validSequence,
  type EntityOp, type EntityType, type Op,
} from '../ops';
import { OpSchema, SET_SCHEMA, VALUE_SCHEMA } from '../wire';
import { requireEdit } from './access';
import { emitOps } from './events';

export interface BatchInput { batchId: string; clientId: string; protocol: number; ops: unknown[] }
export interface BatchResult { seq: number; results: { type: EntityType; id: string; version: number }[]; replayed?: boolean }

const invalid = (opIndex: number, reason: string) => new ApiError('rule_violation', reason, { reason: 'invalid', opIndex });

// SEC-13: user text in node and edge data is sanitised on write; over-length is refused, never cut.
const TEXT_LIMITS: Record<string, number> = {
  title: 200, description: 10_000, label: 200, text: 2_000, area: 120, owner: 120, team: 120, versionTag: 60, journeyStage: 120, status: 120,
};
function cleanData(data: Record<string, unknown>, opIndex: number): Record<string, unknown> {
  const out = { ...data };
  for (const [k, max] of Object.entries(TEXT_LIMITS)) {
    if (typeof out[k] !== 'string') continue;
    try { out[k] = cleanText(out[k] as string, max) ?? ''; } catch (e) {
      if (e instanceof TextTooLong) throw invalid(opIndex, `${k} must be at most ${max} characters.`);
      throw e;
    }
  }
  return out;
}

interface Net {
  type: EntityType; id: string; firstIndex: number;
  create: Record<string, unknown> | null;
  restore: boolean; del: boolean; base: number | null;
  set: Record<string, unknown>; data: Record<string, unknown>; unset: string[];
}

/** Validates every op and folds each object's ops into one net change (validSequence per object). */
function fold(rawOps: unknown[]): { ops: Op[]; nets: Net[]; board: { name?: string; settings?: Record<string, unknown>; unset?: string[] } | null } {
  const ops: Op[] = [];
  const byKey = new Map<string, Net>();
  const seqs = new Map<string, EntityOp['op'][]>();
  let board: { name?: string; settings?: Record<string, unknown>; unset?: string[] } | null = null;

  rawOps.forEach((raw, i) => {
    const p = OpSchema.safeParse(raw);
    if (!p.success) throw invalid(i, `Op ${i} is not valid: ${p.error.issues[0].message} (${p.error.issues[0].path.join('.') || 'op'}).`);
    let op = p.data as Op;
    if (op.type === 'board') {
      const b = board ?? {};
      if (op.name !== undefined) {
        const name = cleanText(op.name, 200);
        if (!name) throw invalid(i, 'A board needs a name.');
        op = { ...op, name }; b.name = name;
      }
      if (op.settings) {
        if (JSON.stringify(op.settings).length > 32_000) throw invalid(i, 'Board settings are too large.');
        b.settings = { ...(b.settings ?? {}), ...op.settings };
      }
      if (op.unsetSettings) b.unset = [...(b.unset ?? []), ...op.unsetSettings];
      board = b; ops.push(op); return;
    }
    const key = `${op.type}:${op.id}`;
    const seq = [...(seqs.get(key) ?? []), op.op];
    if (!validSequence(seq)) throw invalid(i, `Ops on ${key} are in an order that cannot be applied.`);
    seqs.set(key, seq);
    let net = byKey.get(key);
    if (!net) {
      net = { type: op.type, id: op.id, firstIndex: i, create: null, restore: false, del: false, base: null, set: {}, data: {}, unset: [] };
      byKey.set(key, net);
    }
    switch (op.op) {
      case 'create': {
        const v = VALUE_SCHEMA[op.type].safeParse(op.value);
        if (!v.success) throw invalid(i, `Op ${i}: ${v.error.issues[0].message} (${v.error.issues[0].path.join('.')}).`);
        const value = { ...(v.data as Record<string, unknown>) };
        if (op.type === 'node') {
          if (!isRegisteredKind(String(value.kind))) throw invalid(i, 'Unknown card type'); // JB-304
          value.data = cleanData(value.data as Record<string, unknown>, i);
          const parentId = (value.data as Record<string, unknown>).parentId;
          if (parentId && !getKind(String(value.kind))!.canHaveParent) throw invalid(i, 'Only Design cards can have a parent.');
          if (JSON.stringify(value.data).length > CAPS.nodeDataBytes) throw invalid(i, 'Card data is too large.');
        }
        if (op.type === 'edge') {
          value.data = cleanData((value.data ?? {}) as Record<string, unknown>, i);
          if (value.source === value.target) throw invalid(i, 'A connector must join two different cards.');
        }
        net.create = value;
        op = { ...op, value };
        break;
      }
      case 'patch': {
        if (net.create === null && net.base === null && !net.restore) {
          if (op.baseVersion === undefined) throw invalid(i, 'baseVersion is required.');
          net.base = op.baseVersion;
        }
        if (op.set) {
          const s = SET_SCHEMA[op.type].safeParse(op.set);
          if (!s.success) throw invalid(i, `Op ${i}: ${s.error.issues[0].message} (${s.error.issues[0].path.join('.') || 'set'}).`);
        }
        let data = op.data;
        if (data && op.type !== 'field') data = cleanData(data, i);
        if (op.type === 'node' && data && 'parentId' in data && data.parentId !== null && typeof data.parentId !== 'string') throw invalid(i, 'parentId must be a card id.');
        op = { ...op, ...(data && { data }) };
        if (net.create) {
          for (const [k, v] of Object.entries(op.set ?? {})) if (SET_COLUMNS[op.type].includes(k)) net.create[k] = v;
          const dk = op.type === 'field' ? 'extra' : 'data';
          if (op.data || op.unset) net.create[dk] = mergeData((net.create[dk] ?? {}) as Record<string, unknown>, op.data, op.unset);
        } else {
          Object.assign(net.set, op.set ?? {});
          for (const [k, v] of Object.entries(op.data ?? {})) { net.data[k] = v; net.unset = net.unset.filter((u) => u !== k); }
          for (const k of op.unset ?? []) { delete net.data[k]; if (!net.unset.includes(k)) net.unset.push(k); }
        }
        break;
      }
      case 'restore':
      case 'delete':
        if (net.create === null && net.base === null && !net.restore) {
          if (op.baseVersion === undefined) throw invalid(i, 'baseVersion is required.');
          net.base = op.baseVersion;
        }
        if (op.op === 'restore') net.restore = true; else net.del = true;
        if (op.op === 'restore') op = { type: op.type, op: 'restore', id: op.id, baseVersion: op.baseVersion };
        break;
    }
    ops.push(op);
  });
  return { ops, nets: [...byKey.values()], board };
}

const j = (v: unknown) => JSON.stringify(v);

async function insertCreates(tx: Transaction<DB>, boardId: string, seq: number, type: EntityType, nets: Net[]): Promise<Set<string>> {
  if (!nets.length) return new Set();
  const rows = nets.map((n) => {
    const v = n.create as Record<string, unknown>;
    if (type === 'node') {
      const data = v.data as Record<string, unknown>;
      return { id: n.id, kind: v.kind, x: v.x, y: v.y, width: v.width ?? null, height: v.height ?? null, z_index: v.zIndex ?? null,
        parent_id: typeof data.parentId === 'string' && data.parentId ? data.parentId : null, sort_key: v.sortKey, data, del: n.del };
    }
    if (type === 'edge') return { id: n.id, source_id: v.source, target_id: v.target, sort_key: v.sortKey, data: v.data ?? {}, del: n.del };
    return { id: n.id, kind: v.kind, label: v.label, options: v.options ?? [], show_on_card: v.showOnCard ?? false, sort_key: v.sortKey,
      preset_key: v.presetKey ?? null, extra: v.extra ?? {}, del: n.del };
  });
  const q = type === 'node'
    ? sql<{ id: string }>`INSERT INTO jb_node (board_id, id, kind, x, y, width, height, z_index, parent_id, sort_key, data, version, last_seq, deleted_at)
        SELECT ${boardId}, v.id, v.kind, v.x, v.y, v.width, v.height, v.z_index, v.parent_id, v.sort_key, v.data, 1, ${seq}, CASE WHEN v.del THEN now() END
        FROM jsonb_to_recordset(${j(rows)}::jsonb) AS v(id text, kind text, x float8, y float8, width float8, height float8, z_index int, parent_id text, sort_key text, data jsonb, del bool)
        ON CONFLICT (board_id, id) DO NOTHING RETURNING id`
    : type === 'edge'
      ? sql<{ id: string }>`INSERT INTO jb_edge (board_id, id, source_id, target_id, sort_key, data, version, last_seq, deleted_at)
        SELECT ${boardId}, v.id, v.source_id, v.target_id, v.sort_key, v.data, 1, ${seq}, CASE WHEN v.del THEN now() END
        FROM jsonb_to_recordset(${j(rows)}::jsonb) AS v(id text, source_id text, target_id text, sort_key text, data jsonb, del bool)
        ON CONFLICT (board_id, id) DO NOTHING RETURNING id`
      : sql<{ id: string }>`INSERT INTO jb_field (board_id, id, kind, label, options, show_on_card, sort_key, preset_key, extra, version, last_seq, deleted_at)
        SELECT ${boardId}, v.id, v.kind, v.label, v.options, v.show_on_card, v.sort_key, v.preset_key, v.extra, 1, ${seq}, CASE WHEN v.del THEN now() END
        FROM jsonb_to_recordset(${j(rows)}::jsonb) AS v(id text, kind text, label text, options jsonb, show_on_card bool, sort_key text, preset_key text, extra jsonb, del bool)
        ON CONFLICT (board_id, id) DO NOTHING RETURNING id`;
  return new Set((await q.execute(tx)).rows.map((r) => r.id));
}

interface Updated { id: string; version: number; kind?: string; value?: Record<string, unknown> | null }

async function updateExisting(tx: Transaction<DB>, boardId: string, seq: number, type: EntityType, nets: Net[]): Promise<Map<string, Updated>> {
  if (!nets.length) return new Map();
  const rows = j(nets.map((n) => ({ id: n.id, base: n.base, restore: n.restore, del: n.del, set: n.set, data: n.data, unset: n.unset })));
  const from = sql`jsonb_to_recordset(${rows}::jsonb) AS v(id text, base int, restore bool, del bool, set jsonb, data jsonb, unset text[])`;
  const live = sql`(CASE WHEN v.restore THEN t.deleted_at IS NOT NULL ELSE t.deleted_at IS NULL END)`;
  let q;
  if (type === 'node') {
    q = sql<Updated>`UPDATE jb_node t SET
        x = CASE WHEN v.set ? 'x' THEN (v.set->>'x')::float8 ELSE t.x END,
        y = CASE WHEN v.set ? 'y' THEN (v.set->>'y')::float8 ELSE t.y END,
        width = CASE WHEN v.set ? 'width' THEN (v.set->>'width')::float8 ELSE t.width END,
        height = CASE WHEN v.set ? 'height' THEN (v.set->>'height')::float8 ELSE t.height END,
        z_index = CASE WHEN v.set ? 'zIndex' THEN (v.set->>'zIndex')::int ELSE t.z_index END,
        sort_key = CASE WHEN v.set ? 'sortKey' THEN v.set->>'sortKey' ELSE t.sort_key END,
        data = jb_merge_data(t.data, v.data, v.unset),
        parent_id = CASE WHEN v.data ? 'parentId' THEN nullif(v.data->>'parentId', '') WHEN 'parentId' = ANY(v.unset) THEN NULL ELSE t.parent_id END,
        deleted_at = CASE WHEN v.del THEN now() WHEN v.restore THEN NULL ELSE t.deleted_at END,
        version = t.version + 1, last_seq = ${seq}
      FROM ${from}
      WHERE t.board_id = ${boardId} AND t.id = v.id AND t.version = v.base AND ${live}
      RETURNING t.id, t.version, t.kind, CASE WHEN v.restore THEN jsonb_build_object('kind', t.kind, 'x', t.x, 'y', t.y, 'width', t.width,
        'height', t.height, 'zIndex', t.z_index, 'sortKey', t.sort_key, 'data', t.data) END AS value`;
  } else if (type === 'edge') {
    q = sql<Updated>`UPDATE jb_edge t SET
        source_id = CASE WHEN v.set ? 'source' THEN v.set->>'source' ELSE t.source_id END,
        target_id = CASE WHEN v.set ? 'target' THEN v.set->>'target' ELSE t.target_id END,
        sort_key = CASE WHEN v.set ? 'sortKey' THEN v.set->>'sortKey' ELSE t.sort_key END,
        data = jb_merge_data(t.data, v.data, v.unset),
        deleted_at = CASE WHEN v.del THEN now() WHEN v.restore THEN NULL ELSE t.deleted_at END,
        version = t.version + 1, last_seq = ${seq}
      FROM ${from}
      WHERE t.board_id = ${boardId} AND t.id = v.id AND t.version = v.base AND ${live}
      RETURNING t.id, t.version, CASE WHEN v.restore THEN jsonb_build_object('source', t.source_id, 'target', t.target_id,
        'sortKey', t.sort_key, 'data', t.data) END AS value`;
  } else {
    q = sql<Updated>`UPDATE jb_field t SET
        label = CASE WHEN v.set ? 'label' THEN v.set->>'label' ELSE t.label END,
        options = CASE WHEN v.set ? 'options' THEN v.set->'options' ELSE t.options END,
        show_on_card = CASE WHEN v.set ? 'showOnCard' THEN (v.set->>'showOnCard')::bool ELSE t.show_on_card END,
        sort_key = CASE WHEN v.set ? 'sortKey' THEN v.set->>'sortKey' ELSE t.sort_key END,
        extra = jb_merge_data(t.extra, v.data, v.unset),
        deleted_at = CASE WHEN v.del THEN now() WHEN v.restore THEN NULL ELSE t.deleted_at END,
        version = t.version + 1, last_seq = ${seq}
      FROM ${from}
      WHERE t.board_id = ${boardId} AND t.id = v.id AND t.version = v.base AND ${live}
      RETURNING t.id, t.version, CASE WHEN v.restore THEN jsonb_build_object('kind', t.kind, 'label', t.label, 'options', t.options,
        'showOnCard', t.show_on_card, 'sortKey', t.sort_key, 'presetKey', t.preset_key, 'extra', t.extra) END AS value`;
  }
  return new Map((await q.execute(tx)).rows.map((r) => [r.id, r]));
}

const textArray = (xs: string[]) => sql`ARRAY(SELECT jsonb_array_elements_text(${j(xs)}::jsonb))`;

/** INV-19 and INV-20 on the touched set only, in one statement. Returns the first problem or null. */
async function integrity(tx: Transaction<DB>, boardId: string, nets: Net[]): Promise<{ problem: string; id: string } | null> {
  const edgesToCheck = nets.filter((n) => n.type === 'edge' && !n.del && (n.create || n.restore || 'source' in n.set || 'target' in n.set)).map((n) => n.id);
  const deletedNodes = nets.filter((n) => n.type === 'node' && n.del).map((n) => n.id);
  const parents: { id: string; parent: string }[] = [];
  for (const n of nets) {
    if (n.type !== 'node' || n.del) continue;
    const p = n.create ? (n.create.data as Record<string, unknown>).parentId : n.data.parentId;
    if (typeof p === 'string' && p) parents.push({ id: n.id, parent: p });
  }
  if (!edgesToCheck.length && !deletedNodes.length && !parents.length) return null;
  const r = await sql<{ problem: string; id: string }>`
    WITH RECURSIVE ch(id, parent) AS (
      SELECT x->>'id', x->>'parent' FROM jsonb_array_elements(${j(parents)}::jsonb) x
    ), walk(start, cur, depth) AS (
      SELECT id, parent, 1 FROM ch
      UNION ALL
      SELECT w.start, n.parent_id, w.depth + 1 FROM walk w
      JOIN jb_node n ON n.board_id = ${boardId} AND n.id = w.cur AND n.deleted_at IS NULL
      WHERE w.cur <> w.start AND w.depth < 65
    )
    SELECT 'cycle' AS problem, start AS id FROM walk WHERE cur = start OR depth >= 65
    UNION ALL
    SELECT 'parent', ch.id FROM ch WHERE NOT EXISTS (
      SELECT 1 FROM jb_node p WHERE p.board_id = ${boardId} AND p.id = ch.parent AND p.deleted_at IS NULL AND p.kind = 'design-card')
    UNION ALL
    SELECT 'not-design', ch.id FROM ch JOIN jb_node n ON n.board_id = ${boardId} AND n.id = ch.id AND n.kind <> 'design-card'
    UNION ALL
    SELECT 'dangling', e.id FROM jb_edge e
      WHERE e.board_id = ${boardId} AND e.deleted_at IS NULL AND e.id = ANY(${textArray(edgesToCheck)})
        AND (NOT EXISTS (SELECT 1 FROM jb_node s WHERE s.board_id = ${boardId} AND s.id = e.source_id AND s.deleted_at IS NULL)
          OR NOT EXISTS (SELECT 1 FROM jb_node t WHERE t.board_id = ${boardId} AND t.id = e.target_id AND t.deleted_at IS NULL))
    UNION ALL
    SELECT 'orphaned', e.id FROM jb_edge e
      WHERE e.board_id = ${boardId} AND e.deleted_at IS NULL
        AND (e.source_id = ANY(${textArray(deletedNodes)}) OR e.target_id = ANY(${textArray(deletedNodes)}))
    LIMIT 1`.execute(tx);
  return r.rows[0] ?? null;
}

const PROBLEM_TEXT: Record<string, string> = {
  cycle: 'A card cannot be its own ancestor',
  parent: 'A sub-item\'s parent must be a Design card on this board.',
  'not-design': 'Only Design cards can have a parent.',
  dangling: 'A connector must join two cards on this board.',
  orphaned: 'Delete a card\'s connectors with it.',
};

class Replay { constructor(readonly result: BatchResult) {} }

export async function applyBatch(principal: Principal, boardId: string, input: BatchInput): Promise<BatchResult> {
  const access = await requireEdit(principal, boardId);
  if (input.protocol < Math.max(access.row.min_client_protocol, CLIENT_PROTOCOL)) {
    throw new ApiError('client_outdated', 'A new version is available. Reload to keep editing.');
  }
  const { ops, nets, board } = fold(input.ops);

  let result: BatchResult;
  try {
    result = await getDb().transaction().execute(async (tx) => {
      // 1. Lock the board row, allocate seq and check for a replay in one statement (PERF-25 steps 1–2).
      const head = (await sql<{ prior: BatchResult | null; seq: number | null }>`
        WITH prior AS (SELECT result FROM jb_change WHERE board_id = ${boardId} AND batch_id = ${input.batchId}),
        bump AS (UPDATE jb_board SET seq = seq + 1 WHERE id = ${boardId} AND NOT EXISTS (SELECT 1 FROM prior) RETURNING seq)
        SELECT (SELECT result FROM prior) AS prior, (SELECT seq::float8 FROM bump) AS seq`.execute(tx)).rows[0];
      if (head.prior) throw new Replay(head.prior);
      if (head.seq === null) throw new ApiError('not_found', 'Not found.');
      const seq = Number(head.seq);

      // 2. One statement per table and kind of change (PERF-25 step 3). Rows not returned are conflicts.
      const conflicts: { type: EntityType; id: string; reason: string }[] = [];
      const results: BatchResult['results'] = [];
      const restored = new Map<string, Record<string, unknown>>();
      const delta = { node: 0, edge: 0, field: 0 };
      for (const type of ['node', 'edge', 'field'] as const) {
        const creates = nets.filter((n) => n.type === type && n.create);
        const updates = nets.filter((n) => n.type === type && !n.create);
        const inserted = await insertCreates(tx, boardId, seq, type, creates);
        for (const n of creates) {
          if (!inserted.has(n.id)) conflicts.push({ type, id: n.id, reason: 'exists' });
          else { results.push({ type, id: n.id, version: 1 }); if (!n.del) delta[type]++; }
        }
        const updated = await updateExisting(tx, boardId, seq, type, updates);
        for (const n of updates) {
          const u = updated.get(n.id);
          if (!u) { conflicts.push({ type, id: n.id, reason: 'stale' }); continue; }
          if (type === 'node' && n.restore && u.kind && !isRegisteredKind(u.kind)) throw invalid(n.firstIndex, 'Unknown card type');
          results.push({ type, id: n.id, version: u.version });
          if (n.restore && u.value) restored.set(`${type}:${n.id}`, u.value);
          if (n.restore && !n.del) delta[type]++;
          if (!n.restore && n.del) delta[type]--;
        }
      }
      if (conflicts.length) throw new ApiError('conflict', 'Someone else changed these items. Your changes will be merged.', { conflicts });

      // 3. Integrity on the touched set only (PERF-25 step 4).
      const problem = await integrity(tx, boardId, nets);
      if (problem) {
        const net = nets.find((n) => n.id === problem.id);
        throw invalid(net?.firstIndex ?? 0, PROBLEM_TEXT[problem.problem] ?? 'This change is not allowed.');
      }

      // Restore ops carry the restored row so every client can show it (tombstones are never sent on load).
      const applied = ops.map((o) => (o.type !== 'board' && o.op === 'restore' ? { ...o, value: restored.get(`${o.type}:${o.id}`) } : o));
      const out: BatchResult = { seq, results };

      // 4. Change row, counters and board patch in one statement (PERF-25 step 5), then caps.
      const caps = (await sql<{ n: number; e: number; f: number }>`
        WITH ch AS (
          INSERT INTO jb_change (board_id, seq, batch_id, client_id, user_id, ops, result)
          VALUES (${boardId}, ${seq}, ${input.batchId}, ${input.clientId}, ${principal.userId}, ${j(applied)}::jsonb, ${j(out)}::jsonb)
          RETURNING seq)
        UPDATE jb_board SET
          live_node_count = live_node_count + ${delta.node}, live_edge_count = live_edge_count + ${delta.edge},
          live_field_count = live_field_count + ${delta.field},
          name = coalesce(${board?.name ?? null}, name),
          settings = (settings || ${j(board?.settings ?? {})}::jsonb) - ${textArray(board?.unset ?? [])},
          updated_at = now(), updated_by = ${principal.userId}
        WHERE id = ${boardId} AND EXISTS (SELECT 1 FROM ch)
        RETURNING live_node_count AS n, live_edge_count AS e, live_field_count AS f`.execute(tx)).rows[0];
      if (caps.n > CAPS.nodes) throw invalid(0, `A board can hold at most ${CAPS.nodes} cards.`);
      if (caps.e > CAPS.edges) throw invalid(0, `A board can hold at most ${CAPS.edges} connectors.`);
      if (caps.f > CAPS.fields) throw invalid(0, `A board can hold at most ${CAPS.fields} fields.`);

      return { out, applied };
    }).then(({ out, applied }) => {
      // After commit (ARC-22): collaborators see the batch live (JB-1501, D-24).
      emitOps(boardId, { seq: out.seq, batchId: input.batchId, clientId: input.clientId, userId: principal.userId, ops: applied, results: out.results });
      return out;
    });
  } catch (e) {
    if (e instanceof Replay) return { ...e.result, replayed: true };
    const pg = e as { code?: string; constraint?: string; message?: string };
    // Two racing sends of one batch: the loser hits UNIQUE(board_id, batch_id) and answers the stored result (INV-22).
    if (pg.code === '23505' && String(pg.constraint ?? pg.message).includes('batch_id')) {
      const prior = await getDb().selectFrom('jb_change').select('result').where('board_id', '=', boardId).where('batch_id', '=', input.batchId).executeTakeFirst();
      if (prior) return { ...(prior.result as BatchResult), replayed: true };
    }
    if (pg.code === '23514') {
      const c = String(pg.constraint ?? pg.message);
      if (c.includes('jb_field_status_kept')) throw invalid(0, 'The Design status field cannot be deleted.');
      if (c.includes('jb_node_data_size')) throw invalid(0, 'Card data is too large.');
      throw invalid(0, 'This change is not allowed.');
    }
    throw e;
  }
  return result;
}
