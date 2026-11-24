// Board ops (JB-1601): pure types and functions shared by the client store and the server.
// Apply is O(1) per op (PERF-23). Inverses and fine-grained keys drive collaborator-safe undo (JB-1703).

export type EntityType = 'node' | 'edge' | 'field';

export interface NodeRec {
  id: string; kind: string; x: number; y: number; width: number | null; height: number | null;
  zIndex: number | null; sortKey: string; data: Record<string, unknown>; version: number;
}
export interface EdgeRec { id: string; source: string; target: string; sortKey: string; data: Record<string, unknown>; version: number }
export interface FieldOption { id: string; label: string; colour: string }
export interface FieldRec {
  id: string; kind: 'picker' | 'text' | 'toggle' | 'date'; label: string; options: FieldOption[]; showOnCard: boolean;
  sortKey: string; presetKey: string | null; extra: Record<string, unknown>; version: number;
}
export type Rec = NodeRec | EdgeRec | FieldRec;

export interface CreateOp { type: EntityType; op: 'create'; id: string; value: Record<string, unknown> }
export interface PatchOp {
  type: EntityType; op: 'patch'; id: string; baseVersion?: number;
  /** Top-level columns: node x/y/width/height/zIndex/sortKey; edge source/target/sortKey; field label/options/showOnCard/sortKey. */
  set?: Record<string, unknown>;
  /** Merged one level into node/edge `data` or field `extra`. `fieldValues.<fieldId>` merges one level deeper. */
  data?: Record<string, unknown>;
  unset?: string[];
}
export interface DeleteOp { type: EntityType; op: 'delete'; id: string; baseVersion?: number }
/** `value` is filled in by the server with the restored row, so every client can show it (tombstones are never sent). */
export interface RestoreOp { type: EntityType; op: 'restore'; id: string; baseVersion?: number; value?: Record<string, unknown> }
export interface BoardPatchOp { type: 'board'; op: 'patch'; name?: string; settings?: Record<string, unknown>; unsetSettings?: string[] }
export type EntityOp = CreateOp | PatchOp | DeleteOp | RestoreOp;
export type Op = EntityOp | BoardPatchOp;

export const SET_COLUMNS: Record<EntityType, readonly string[]> = {
  node: ['x', 'y', 'width', 'height', 'zIndex', 'sortKey'],
  edge: ['source', 'target', 'sortKey'],
  field: ['label', 'options', 'showOnCard', 'sortKey'],
};
export const FIELD_VALUE_PREFIX = 'fieldValues.';
export const MAX_OPS_PER_BATCH = 500;
export const CLIENT_PROTOCOL = 1;
export const CAPS = { nodes: 5000, edges: 10000, fields: 200, nodeDataBytes: 256 * 1024 } as const;

export const objKey = (type: EntityType, id: string) => `${type}:${id}`;

export interface BoardDoc {
  name: string;
  settings: Record<string, unknown>;
  nodes: Map<string, NodeRec>;
  edges: Map<string, EdgeRec>;
  fields: Map<string, FieldRec>;
}

export function emptyDoc(name = '', settings: Record<string, unknown> = {}): BoardDoc {
  return { name, settings, nodes: new Map(), edges: new Map(), fields: new Map() };
}

export const cloneRec = <T extends Rec>(r: T): T => structuredClone(r);

function mapOf(doc: BoardDoc, type: EntityType): Map<string, Rec> {
  return (type === 'node' ? doc.nodes : type === 'edge' ? doc.edges : doc.fields) as Map<string, Rec>;
}
export const getRec = (doc: BoardDoc, type: EntityType, id: string): Rec | undefined => mapOf(doc, type).get(id);

/** Data merge with explicit unset (null is a value). `fieldValues.<id>` paths merge into the nested map. */
export function mergeData(base: Record<string, unknown>, patch: Record<string, unknown> | undefined, unset: string[] | undefined) {
  const out: Record<string, unknown> = { ...base };
  const fv = () => {
    const cur = out.fieldValues;
    const next = cur && typeof cur === 'object' && !Array.isArray(cur) ? { ...(cur as Record<string, unknown>) } : {};
    out.fieldValues = next;
    return next;
  };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k.startsWith(FIELD_VALUE_PREFIX)) fv()[k.slice(FIELD_VALUE_PREFIX.length)] = v;
    else out[k] = v;
  }
  for (const k of unset ?? []) {
    if (k.startsWith(FIELD_VALUE_PREFIX)) delete fv()[k.slice(FIELD_VALUE_PREFIX.length)];
    else delete out[k];
  }
  return out;
}

/** Builds a full record from a create value (defaults for anything missing). */
export function recFromValue(type: EntityType, id: string, value: Record<string, unknown>, version = 1): Rec {
  const v = value as Record<string, never>;
  if (type === 'node') {
    return { id, kind: String(v.kind), x: Number(v.x ?? 0), y: Number(v.y ?? 0), width: v.width ?? null, height: v.height ?? null,
      zIndex: v.zIndex ?? null, sortKey: String(v.sortKey ?? 'V'), data: (v.data ?? {}) as Record<string, unknown>, version };
  }
  if (type === 'edge') {
    return { id, source: String(v.source), target: String(v.target), sortKey: String(v.sortKey ?? 'V'), data: (v.data ?? {}) as Record<string, unknown>, version };
  }
  return { id, kind: v.kind ?? 'text', label: String(v.label ?? 'Field'), options: (v.options ?? []) as FieldOption[],
    showOnCard: Boolean(v.showOnCard), sortKey: String(v.sortKey ?? 'V'), presetKey: v.presetKey ?? null,
    extra: (v.extra ?? {}) as Record<string, unknown>, version } as FieldRec;
}

/** Inverse of recFromValue: the value a create or restore op carries. */
export function valueOf(type: EntityType, r: Rec): Record<string, unknown> {
  const { id: _id, version: _v, ...rest } = r as unknown as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars
  void type;
  return structuredClone(rest);
}

export function patchRec<T extends Rec>(type: EntityType, r: T, op: PatchOp): T {
  const out = { ...r } as Record<string, unknown>;
  for (const [k, v] of Object.entries(op.set ?? {})) if (SET_COLUMNS[type].includes(k)) out[k] = v;
  if (op.data || op.unset) {
    const key = type === 'field' ? 'extra' : 'data';
    out[key] = mergeData(out[key] as Record<string, unknown>, op.data, op.unset);
  }
  return out as T;
}

/**
 * Applies one op to a doc in place. Returns false when the op cannot apply (object missing, already live, …),
 * which the caller treats as "skip" (remote) or "drop" (rebase). Versions: `version` if given, else +1.
 */
export function applyOp(doc: BoardDoc, op: Op, version?: number): boolean {
  if (op.type === 'board') {
    if (op.name !== undefined) doc.name = op.name;
    if (op.settings || op.unsetSettings) {
      const s = { ...doc.settings, ...(op.settings ?? {}) };
      for (const k of op.unsetSettings ?? []) delete s[k];
      doc.settings = s;
    }
    return true;
  }
  const m = mapOf(doc, op.type);
  const cur = m.get(op.id);
  switch (op.op) {
    case 'create':
      if (cur) return false;
      m.set(op.id, recFromValue(op.type, op.id, op.value, version ?? 1));
      return true;
    case 'restore':
      if (cur) return false;
      if (!op.value) return false;
      m.set(op.id, recFromValue(op.type, op.id, op.value, version ?? (op.baseVersion ?? 0) + 1));
      return true;
    case 'patch':
      if (!cur) return false;
      m.set(op.id, { ...patchRec(op.type, cur, op), version: version ?? cur.version + 1 });
      return true;
    case 'delete':
      if (!cur) return false;
      m.delete(op.id);
      return true;
  }
}

// ── fine-grained keys (JB-1703) ────────────────────────────────────────────
function setKey(type: EntityType, id: string, col: string): string {
  if (type === 'node') {
    if (col === 'x' || col === 'y') return `node:${id}:position`;
    if (col === 'width' || col === 'height') return `node:${id}:size`;
    if (col === 'sortKey') return `node:${id}:order`;
    return `node:${id}:${col}`;
  }
  return `${type}:${id}:${col === 'sortKey' ? 'order' : col}`;
}
function dataKey(type: EntityType, id: string, k: string): string {
  const prefix = type === 'field' ? 'extra' : 'data';
  if (type === 'node' && k.startsWith(FIELD_VALUE_PREFIX)) return `node:${id}:${k}`;
  return `${type}:${id}:${prefix}.${k}`;
}

/** The keys an op changes. Create, delete and restore change the object's existence key. */
export function opKeys(op: Op): string[] {
  if (op.type === 'board') {
    return [
      ...(op.name !== undefined ? ['board:name'] : []),
      ...Object.keys(op.settings ?? {}).map((k) => `board:settings.${k}`),
      ...(op.unsetSettings ?? []).map((k) => `board:settings.${k}`),
    ];
  }
  if (op.op !== 'patch') return [`${op.type}:${op.id}:exists`];
  return [
    ...Object.keys(op.set ?? {}).map((c) => setKey(op.type, op.id, c)),
    ...Object.keys(op.data ?? {}).map((k) => dataKey(op.type, op.id, k)),
    ...(op.unset ?? []).map((k) => dataKey(op.type, op.id, k)),
  ];
}

/** Removes the parts of an op whose keys are in `skip`. Returns null if nothing remains. */
export function withoutKeys(op: Op, skip: Set<string>): Op | null {
  if (!skip.size) return op;
  if (op.type === 'board') {
    const out: BoardPatchOp = { type: 'board', op: 'patch' };
    if (op.name !== undefined && !skip.has('board:name')) out.name = op.name;
    const s = Object.entries(op.settings ?? {}).filter(([k]) => !skip.has(`board:settings.${k}`));
    if (s.length) out.settings = Object.fromEntries(s);
    const u = (op.unsetSettings ?? []).filter((k) => !skip.has(`board:settings.${k}`));
    if (u.length) out.unsetSettings = u;
    return out.name !== undefined || out.settings || out.unsetSettings ? out : null;
  }
  if (op.op !== 'patch') return skip.has(`${op.type}:${op.id}:exists`) ? null : op;
  const set = Object.entries(op.set ?? {}).filter(([c]) => !skip.has(setKey(op.type, op.id, c)));
  const data = Object.entries(op.data ?? {}).filter(([k]) => !skip.has(dataKey(op.type, op.id, k)));
  const unset = (op.unset ?? []).filter((k) => !skip.has(dataKey(op.type, op.id, k)));
  if (!set.length && !data.length && !unset.length) return null;
  const out: PatchOp = { type: op.type, op: 'patch', id: op.id };
  if (set.length) out.set = Object.fromEntries(set);
  if (data.length) out.data = Object.fromEntries(data);
  if (unset.length) out.unset = unset;
  return out;
}

// ── inverses (JB-1701) ─────────────────────────────────────────────────────
/** The op that undoes `op`, computed against the doc BEFORE `op` is applied. Null when `op` would change nothing. */
export function invertOp(doc: BoardDoc, op: Op): Op | null {
  if (op.type === 'board') {
    const inv: BoardPatchOp = { type: 'board', op: 'patch' };
    if (op.name !== undefined) inv.name = doc.name;
    const keys = [...Object.keys(op.settings ?? {}), ...(op.unsetSettings ?? [])];
    const settings: Record<string, unknown> = {}; const unset: string[] = [];
    for (const k of keys) { if (k in doc.settings) settings[k] = structuredClone(doc.settings[k]); else unset.push(k); }
    if (Object.keys(settings).length) inv.settings = settings;
    if (unset.length) inv.unsetSettings = unset;
    return inv;
  }
  const cur = getRec(doc, op.type, op.id);
  switch (op.op) {
    case 'create': return { type: op.type, op: 'delete', id: op.id };
    case 'restore': return { type: op.type, op: 'delete', id: op.id };
    case 'delete': return cur ? { type: op.type, op: 'restore', id: op.id, value: valueOf(op.type, cur) } : null;
    case 'patch': {
      if (!cur) return null;
      const inv: PatchOp = { type: op.type, op: 'patch', id: op.id };
      const c = cur as unknown as Record<string, unknown>;
      if (op.set) inv.set = Object.fromEntries(Object.keys(op.set).map((k) => [k, structuredClone(c[k] ?? null)]));
      const base = (op.type === 'field' ? (cur as FieldRec).extra : (cur as NodeRec).data) ?? {};
      const fv = (base.fieldValues && typeof base.fieldValues === 'object' ? base.fieldValues : {}) as Record<string, unknown>;
      const data: Record<string, unknown> = {}; const unset: string[] = [];
      for (const k of [...Object.keys(op.data ?? {}), ...(op.unset ?? [])]) {
        const isFv = op.type === 'node' && k.startsWith(FIELD_VALUE_PREFIX);
        const holder = isFv ? fv : base;
        const kk = isFv ? k.slice(FIELD_VALUE_PREFIX.length) : k;
        if (kk in holder) data[k] = structuredClone(holder[kk]); else unset.push(k);
      }
      if (Object.keys(data).length) inv.data = data;
      if (unset.length) inv.unset = unset;
      return inv;
    }
  }
}

/** True when a patch would leave the record exactly as it is (JB-1702: no-op actions record no step). */
export function isNoopPatch(doc: BoardDoc, op: PatchOp): boolean {
  const cur = getRec(doc, op.type, op.id);
  if (!cur) return true;
  const next = patchRec(op.type, cur, op);
  return JSON.stringify({ ...next, version: 0 }) === JSON.stringify({ ...cur, version: 0 });
}

// ── outbox folding (JB-1603) ───────────────────────────────────────────────
/**
 * Appends `op` to a pending op list, folding where the server allows it:
 *   patch after create → merged into the create; patch after patch → merged;
 *   delete after create → both removed (net nothing); restore after delete → both removed.
 * The result always satisfies `validSequence` per object.
 */
export function foldInto(list: Op[], op: Op): Op[] {
  if (op.type === 'board') {
    const i = list.findIndex((o) => o.type === 'board');
    if (i < 0) return [...list, op];
    const prev = list[i] as BoardPatchOp;
    const merged: BoardPatchOp = { type: 'board', op: 'patch' };
    const name = op.name !== undefined ? op.name : prev.name;
    if (name !== undefined) merged.name = name;
    const settings = { ...(prev.settings ?? {}), ...(op.settings ?? {}) };
    const unset = new Set(prev.unsetSettings ?? []);
    for (const k of Object.keys(op.settings ?? {})) unset.delete(k);
    for (const k of op.unsetSettings ?? []) { unset.add(k); delete settings[k]; }
    if (Object.keys(settings).length) merged.settings = settings;
    if (unset.size) merged.unsetSettings = [...unset];
    const out = [...list]; out[i] = merged; return out;
  }
  let lastIdx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    const o = list[i];
    if (o.type === op.type && o.op !== undefined && (o as EntityOp).id === op.id) { lastIdx = i; break; }
  }
  const last = lastIdx >= 0 ? list[lastIdx] as EntityOp : null;
  if (op.op === 'patch' && last) {
    if (last.op === 'create') {
      const value = { ...last.value };
      for (const [k, v] of Object.entries(op.set ?? {})) if (SET_COLUMNS[op.type].includes(k)) value[k] = v;
      const key = op.type === 'field' ? 'extra' : 'data';
      if (op.data || op.unset) value[key] = mergeData((value[key] ?? {}) as Record<string, unknown>, op.data, op.unset);
      const out = [...list]; out[lastIdx] = { ...last, value }; return out;
    }
    if (last.op === 'patch') {
      const set = { ...(last.set ?? {}), ...(op.set ?? {}) };
      const data = { ...(last.data ?? {}) };
      const unset = new Set(last.unset ?? []);
      for (const [k, v] of Object.entries(op.data ?? {})) { data[k] = v; unset.delete(k); }
      for (const k of op.unset ?? []) { delete data[k]; unset.add(k); }
      const merged: PatchOp = { type: op.type, op: 'patch', id: op.id, ...(last.baseVersion !== undefined && { baseVersion: last.baseVersion }) };
      if (Object.keys(set).length) merged.set = set;
      if (Object.keys(data).length) merged.data = data;
      if (unset.size) merged.unset = [...unset];
      const out = [...list]; out[lastIdx] = merged; return out;
    }
  }
  if (op.op === 'delete' && last) {
    const hasCreate = list.some((o) => o.type === op.type && (o as EntityOp).id === op.id && (o as EntityOp).op === 'create');
    if (hasCreate) return list.filter((o) => !(o.type === op.type && (o as EntityOp).id === op.id));
  }
  if (op.op === 'restore' && last?.op === 'delete') {
    const out = [...list]; out.splice(lastIdx, 1); return out;
  }
  return [...list, op];
}

/** Per object the server accepts: (create | restore)? patch* delete?  (JB-1602 all-or-nothing batches). */
export function validSequence(ops: EntityOp['op'][]): boolean {
  let i = 0;
  if (ops[i] === 'create' || ops[i] === 'restore') i++;
  while (ops[i] === 'patch') i++;
  if (ops[i] === 'delete') i++;
  return i === ops.length;
}

/** Re-stamps base versions from the server layer at send time (JB-1604). Ops on objects created in the batch get none. */
export function stampBaseVersions(ops: Op[], server: BoardDoc): Op[] {
  const created = new Set<string>();
  return ops.map((o) => {
    if (o.type === 'board') return o;
    const k = objKey(o.type, o.id);
    if (o.op === 'create') { created.add(k); return o; }
    if (created.has(k)) { const { baseVersion: _b, ...rest } = o as PatchOp; void _b; return rest as Op; } // eslint-disable-line @typescript-eslint/no-unused-vars
    const rec = getRec(server, o.type, o.id);
    if (o.op === 'restore') return { ...o, baseVersion: (o as RestoreOp).baseVersion ?? 0 };
    return { ...o, baseVersion: rec?.version ?? (o as PatchOp).baseVersion ?? 0 };
  });
}

/**
 * Conflict rebase (JB-1605): keep ops on live objects, drop ops on objects deleted remotely.
 * Returns the kept ops and how many were dropped.
 */
export function rebase(ops: Op[], server: BoardDoc): { ops: Op[]; dropped: number } {
  const kept: Op[] = []; let dropped = 0;
  const createdHere = new Set<string>();
  for (const o of ops) {
    if (o.type === 'board') { kept.push(o); continue; }
    const k = objKey(o.type, o.id);
    const live = Boolean(getRec(server, o.type, o.id));
    let ok: boolean;
    if (o.op === 'create') { ok = !live; if (ok) createdHere.add(k); }
    else if (o.op === 'restore') ok = !live;
    else ok = live || createdHere.has(k);
    if (ok) kept.push(o); else dropped++;
  }
  return { ops: kept, dropped };
}
