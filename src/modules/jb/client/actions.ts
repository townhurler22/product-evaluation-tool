// Editing actions (§8.2 to §8.9). Each builds ops and hands them to the store as ONE undo step.
// Pure apart from the store, so they are unit-tested without React.
import { getKind, readDesignCard, readProductCard, readSection, readText } from '../kinds';
import { insideSection, nodeSize, wouldCycle, effectiveArea } from '../derive';
import type { NodeRec, Op } from '../ops';
import { keyBetween } from '../sortkey';
import { nodeCreate, type BoardStore } from './store';

export const newLocalId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
const nowIso = () => new Date().toISOString();

function lastSortKey(nodes: Iterable<{ sortKey: string }>): string | null {
  let max: string | null = null;
  for (const n of nodes) if (max === null || n.sortKey > max) max = n.sortKey;
  return max;
}

export function addNode(store: BoardStore, kind: string, x: number, y: number, data: Record<string, unknown> = {}): string | null {
  const def = getKind(kind);
  if (!def) return null;
  const id = newLocalId();
  const base = def.defaults();
  if (kind === 'design-card' || kind === 'product-card') base.updatedAt = nowIso();
  const op = nodeCreate(id, kind, Math.round(x), Math.round(y), keyBetween(lastSortKey(store.view.nodes.values()), null), { ...base, ...data }, def.size);
  return store.edit([op]) ? id : null;
}

/** Children map from data.parentId (PERF-23: built once per change, not per frame). */
export function childrenOf(nodes: Map<string, NodeRec>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const n of nodes.values()) {
    if (n.kind !== 'design-card') continue;
    const p = readDesignCard(n.data).parentId;
    if (p && nodes.has(p)) { const l = out.get(p) ?? []; l.push(n.id); out.set(p, l); }
  }
  return out;
}

export function descendants(id: string, kids: Map<string, string[]>): string[] {
  const out: string[] = []; const stack = [...(kids.get(id) ?? [])]; const seen = new Set<string>();
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c)) continue;
    seen.add(c); out.push(c); stack.push(...(kids.get(c) ?? []));
  }
  return out;
}

/** JB-204: what a drag carries: a Design card its subtree, a section the nodes inside it. Computed once at drag start. */
export function carriedBy(store: BoardStore, draggedIds: string[]): string[] {
  const nodes = store.view.nodes;
  const kids = childrenOf(nodes);
  const carried = new Set<string>();
  for (const id of draggedIds) {
    const n = nodes.get(id);
    if (!n) continue;
    const carries = getKind(n.kind)?.carries ?? 'none';
    if (carries === 'subtree') for (const d of descendants(id, kids)) carried.add(d);
    if (carries === 'members') for (const m of nodes.values()) if (insideSection(m, n)) carried.add(m.id);
  }
  for (const id of draggedIds) carried.delete(id);
  return [...carried];
}

/** PERF-22: one batch and one undo step on drag stop, with every moved node (dragged plus carried). */
export function commitMove(store: BoardStore, positions: Map<string, { x: number; y: number }>): boolean {
  const ops: Op[] = [];
  for (const [id, p] of positions) {
    const n = store.view.nodes.get(id);
    if (!n || (n.x === p.x && n.y === p.y)) continue;
    ops.push({ type: 'node', op: 'patch', id, set: { x: Math.round(p.x), y: Math.round(p.y) } });
  }
  return store.edit(ops);
}

/** NFR-04: Alt + arrow moves the selection by 8 units (with Shift, by 1), carrying subtrees and section members. */
export function nudge(store: BoardStore, ids: string[], dx: number, dy: number): number {
  const all = [...ids, ...carriedBy(store, ids)];
  const pos = new Map<string, { x: number; y: number }>();
  for (const id of all) { const n = store.view.nodes.get(id); if (n) pos.set(id, { x: n.x + dx, y: n.y + dy }); }
  return commitMove(store, pos) ? pos.size : 0;
}

/** JB-205, JB-702, JB-806: delete with attached connectors; sub-items kept (moved to the parent) or deleted with the branch. */
export function deleteNodes(store: BoardStore, ids: string[], subItems: 'keep' | 'all' = 'keep'): number {
  const nodes = store.view.nodes;
  const kids = childrenOf(nodes);
  const del = new Set(ids.filter((i) => nodes.has(i)));
  if (subItems === 'all') for (const id of [...del]) for (const d of descendants(id, kids)) del.add(d);
  const ops: Op[] = [];
  if (subItems === 'keep') {
    for (const id of del) {
      const parent = readDesignCard(nodes.get(id)!.data).parentId;
      let target = parent; // the nearest surviving ancestor
      while (target && del.has(target)) target = readDesignCard(nodes.get(target)?.data ?? {}).parentId;
      for (const c of kids.get(id) ?? []) {
        if (del.has(c)) continue;
        const cd = readDesignCard(nodes.get(c)!.data);
        const area = cd.area ? {} : { area: effectiveArea(c, (x) => nodes.get(x)) }; // JB-804: detaching keeps the effective area
        ops.push({ type: 'node', op: 'patch', id: c, data: { parentId: target ?? null, ...area } });
      }
    }
  }
  for (const e of store.view.edges.values()) if (del.has(e.source) || del.has(e.target)) ops.push({ type: 'edge', op: 'delete', id: e.id });
  for (const id of del) ops.push({ type: 'node', op: 'delete', id });
  return store.edit(ops) ? del.size : 0;
}

/** JB-205: duplicate (with connectors between duplicated cards), offset by 40. */
export function duplicate(store: BoardStore, ids: string[]): string[] {
  const map = new Map<string, string>();
  const ops: Op[] = [];
  let key = lastSortKey(store.view.nodes.values());
  for (const id of ids) {
    const n = store.view.nodes.get(id);
    if (!n) continue;
    const nid = newLocalId(); map.set(id, nid);
    key = keyBetween(key, null);
    const data = structuredClone(n.data);
    if (typeof data.parentId === 'string' && !ids.includes(data.parentId)) data.parentId = null;
    ops.push(nodeCreate(nid, n.kind, n.x + 40, n.y + 40, key, data, n.width && n.height ? { width: n.width, height: n.height, zIndex: n.zIndex ?? undefined } : undefined));
  }
  for (const op of ops) {
    const d = (op as unknown as { value: { data: Record<string, unknown> } }).value.data;
    if (typeof d.parentId === 'string' && map.has(d.parentId)) d.parentId = map.get(d.parentId);
  }
  let ek = lastSortKey(store.view.edges.values());
  for (const e of store.view.edges.values()) {
    if (map.has(e.source) && map.has(e.target)) {
      ek = keyBetween(ek, null);
      ops.push({ type: 'edge', op: 'create', id: newLocalId(), value: { source: map.get(e.source), target: map.get(e.target), sortKey: ek, data: structuredClone(e.data) } });
    }
  }
  return store.edit(ops) ? [...map.values()] : [];
}

/** JB-404: a panel edit is one patch that also sets updatedAt; typing in one field coalesces per field (JB-1702). */
export function patchCard(store: BoardStore, id: string, data: Record<string, unknown>, opts: { touch?: boolean } = {}) {
  const n = store.view.nodes.get(id);
  if (!n) return false;
  const touch = opts.touch !== false && (n.kind === 'design-card' || n.kind === 'product-card');
  const keys = Object.keys(data).sort().join(',');
  return store.edit([{ type: 'node', op: 'patch', id, data: { ...data, ...(touch ? { updatedAt: nowIso() } : {}) } }], { key: `node:${id}:${keys}` });
}

export function setFieldValue(store: BoardStore, id: string, fieldId: string, value: unknown) {
  const op: Op = value === null || value === '' || value === undefined
    ? { type: 'node', op: 'patch', id, unset: [`fieldValues.${fieldId}`], data: { updatedAt: nowIso() } }
    : { type: 'node', op: 'patch', id, data: { [`fieldValues.${fieldId}`]: value, updatedAt: nowIso() } };
  return store.edit([op], { key: `node:${id}:fv:${fieldId}` });
}

/** JB-403: Mark reviewed sets reviewedAt/By and deliberately leaves updatedAt unchanged. */
export function markReviewed(store: BoardStore, ids: string[], who: string) {
  const at = nowIso();
  return store.edit(ids.filter((i) => store.view.nodes.get(i)?.kind === 'design-card')
    .map((id) => ({ type: 'node', op: 'patch', id, data: { reviewedAt: at, reviewedBy: who } }) as Op));
}

/** JB-802/803: reparent Design cards; skipped on the client when it would make a cycle. Returns how many moved. */
export function assignParent(store: BoardStore, ids: string[], parentId: string | null, inheritArea = false): number {
  const nodes = store.view.nodes;
  const parent = parentId ? nodes.get(parentId) : null;
  if (parentId && parent?.kind !== 'design-card') return 0;
  const ops: Op[] = [];
  for (const id of ids) {
    const n = nodes.get(id);
    if (!n || n.kind !== 'design-card' || id === parentId) continue;
    if (wouldCycle(id, parentId, (x) => nodes.get(x))) continue;
    const d = readDesignCard(n.data);
    const extra: Record<string, unknown> = {};
    if (!parentId && !d.area) extra.area = effectiveArea(id, (x) => nodes.get(x)); // JB-804
    if (parentId && inheritArea) extra.area = '';
    ops.push({ type: 'node', op: 'patch', id, data: { parentId, ...extra } });
  }
  return store.edit(ops) ? ops.length : 0;
}

export function connect(store: BoardStore, source: string, target: string, sourceHandle?: string | null, targetHandle?: string | null): string | null {
  if (source === target || !store.view.nodes.has(source) || !store.view.nodes.has(target)) return null;
  const id = newLocalId();
  const ok = store.edit([{ type: 'edge', op: 'create', id, value: { source, target, sortKey: keyBetween(lastSortKey(store.view.edges.values()), null),
    data: { label: '', directed: true, ...(sourceHandle ? { sourceHandle } : {}), ...(targetHandle ? { targetHandle } : {}) } } }]);
  return ok ? id : null;
}

/** NFR-04: the accessible name of a node. */
export function nodeLabel(n: NodeRec, statusLabel?: (optionId: string) => string | undefined): string {
  switch (n.kind) {
    case 'design-card': {
      const d = readDesignCard(n.data);
      const st = statusLabel?.(String(d.fieldValues.status ?? ''));
      return `Design card: ${d.title}${st ? `, ${st}` : ''}${d.owner ? `, owner ${d.owner}` : ''}`;
    }
    case 'product-card': {
      const p = readProductCard(n.data);
      return `Product card: ${p.title}${p.journeyStage ? `, ${p.journeyStage}` : ''}`;
    }
    case 'section': return `Section: ${readSection(n.data).label}`;
    case 'text': return `Text: ${readText(n.data).text.slice(0, 80)}`;
    case 'stats': return 'Statistics widget';
    default: return 'Unsupported card';
  }
}

/**
 * PERF-22 / D-16: a drag keeps positions in transient state only. No ops, undo entries, outbox or
 * IndexedDB writes until `end()`, which commits ONE batch and ONE undo step. Smart-guide lookups use a
 * uniform 512-unit grid built once at drag start, so each frame checks only nearby nodes.
 */
export class DragSession {
  readonly start = new Map<string, { x: number; y: number }>();
  readonly moving: string[];
  private grid = new Map<string, NodeRec[]>();
  static CELL = 512;

  constructor(private readonly store: BoardStore, dragged: string[]) {
    this.moving = [...dragged, ...carriedBy(store, dragged)];
    for (const id of this.moving) { const n = store.view.nodes.get(id); if (n) this.start.set(id, { x: n.x, y: n.y }); }
    const skip = new Set(this.moving);
    for (const n of store.view.nodes.values()) {
      if (skip.has(n.id)) continue;
      const k = `${Math.floor(n.x / DragSession.CELL)}:${Math.floor(n.y / DragSession.CELL)}`;
      const l = this.grid.get(k) ?? []; l.push(n); this.grid.set(k, l);
    }
  }

  /** Transient positions for a drag delta; touches nothing in the store. */
  positions(dx: number, dy: number): Map<string, { x: number; y: number }> {
    const out = new Map<string, { x: number; y: number }>();
    for (const [id, p] of this.start) out.set(id, { x: p.x + dx, y: p.y + dy });
    return out;
  }

  /** Nodes near a point (the 3×3 grid cells around it), for snapping guides. */
  near(x: number, y: number): NodeRec[] {
    const cx = Math.floor(x / DragSession.CELL), cy = Math.floor(y / DragSession.CELL);
    const out: NodeRec[] = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) out.push(...(this.grid.get(`${cx + i}:${cy + j}`) ?? []));
    return out;
  }

  end(dx: number, dy: number): boolean { return commitMove(this.store, this.positions(dx, dy)); }
}

/** NFR-04: the nearest node in an arrow direction from `from` (by centre points, within a 90° cone). */
export function nearestInDirection(nodes: Iterable<NodeRec>, from: NodeRec, dir: 'up' | 'down' | 'left' | 'right'): NodeRec | null {
  const c = (n: NodeRec) => { const s = nodeSize(n); return { x: n.x + s.w / 2, y: n.y + s.h / 2 }; };
  const o = c(from);
  let best: NodeRec | null = null; let bestScore = Infinity;
  for (const n of nodes) {
    if (n.id === from.id) continue;
    const p = c(n); const dx = p.x - o.x; const dy = p.y - o.y;
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0 || across > along) continue;
    const score = along + across * 2;
    if (score < bestScore) { bestScore = score; best = n; }
  }
  return best;
}
