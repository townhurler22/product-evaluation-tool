// Board store (PERF-21, PERF-23, JB-1503, JB-1701 to JB-1703). Framework-free so it is unit-tested directly.
// Layers: `server` (applied batches, in seq order) and `view` = server + inflight + pending local ops.
// Components read the view through per-node selectors; a change notifies listeners, and React only
// re-renders components whose selected value changed reference (D-14, D-15).
import {
  applyOp, emptyDoc, foldInto, getRec, invertOp, isNoopPatch, objKey, opKeys, recFromValue, withoutKeys,
  type BoardDoc, type EdgeRec, type EntityType, type FieldRec, type NodeRec, type Op,
} from '../ops';

export interface RemoteBatch { seq: number; batchId: string; clientId: string; userId: string | null; ops: Op[]; results: { type: EntityType; id: string; version: number }[] }
export interface Inflight { batchId: string; ops: Op[] }

interface Step { key: string | null; at: number; ops: Op[]; inverses: Op[]; startTick: number }
const HISTORY_MAX = 50;
const COALESCE_MS = 1000;

export interface ContentIn { seq: number; name: string; settings: Record<string, unknown>; nodes: NodeRec[]; edges: EdgeRec[]; fields: FieldRec[] }

type Listener = () => void;

export class BoardStore {
  server: BoardDoc = emptyDoc();
  view: BoardDoc = emptyDoc();
  seq = 0;
  pending: Op[] = [];
  inflight: Inflight | null = null;
  readOnly: boolean;
  /** Bumped on every notify; lets non-node subscribers (outline, counts) memoise on it. */
  revision = 0;

  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private remoteTick = 0;
  private remoteKeys = new Map<string, number>(); // JB-1503: keys collaborators changed, for JB-1703
  private listeners = new Set<Listener>();
  /** Called whenever local ops are added (the sync engine debounces a flush, JB-1604). */
  onLocalEdit: (() => void) | null = null;
  /** Called when a remote batch deletes the card whose panel is open (JB-1504). */
  onRemoteDelete: ((nodeId: string, userId: string | null) => void) | null = null;

  constructor(readonly clientId: string, readOnly = false) { this.readOnly = readOnly; }

  setHandlers(h: { onLocalEdit?: (() => void) | null; onRemoteDelete?: ((nodeId: string, userId: string | null) => void) | null }) {
    if (h.onLocalEdit !== undefined) this.onLocalEdit = h.onLocalEdit;
    if (h.onRemoteDelete !== undefined) this.onRemoteDelete = h.onRemoteDelete;
  }

  // ── subscription ──
  subscribe = (l: Listener) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  private notify() { this.revision++; for (const l of this.listeners) l(); }

  // ── loading ──
  load(c: ContentIn) {
    const doc = emptyDoc(c.name, c.settings ?? {});
    for (const n of c.nodes) doc.nodes.set(n.id, n);
    for (const e of c.edges) doc.edges.set(e.id, e);
    for (const f of c.fields) doc.fields.set(f.id, f);
    this.server = doc;
    this.seq = c.seq;
    this.rebuildView();
  }

  /** Rebuilds the whole view: only on load or resync, never per edit. */
  private rebuildView() {
    const v = emptyDoc(this.server.name, { ...this.server.settings });
    v.nodes = new Map(this.server.nodes); v.edges = new Map(this.server.edges); v.fields = new Map(this.server.fields);
    for (const o of this.outboxOps()) applyOp(v, o);
    this.view = v;
    this.notify();
  }

  outboxOps(): Op[] { return [...(this.inflight?.ops ?? []), ...this.pending]; }
  get unsentCount() { return this.outboxOps().length; }

  // ── local edits (JB-1702) ──
  /**
   * Applies local ops to the view, records one undo step (coalesced by key within 1 s) and queues
   * them in the outbox. Returns false when read-only (JB-1306: the store refuses to produce ops).
   */
  edit(ops: Op[], opts: { key?: string; history?: boolean } = {}): boolean {
    if (this.readOnly || !ops.length) return false;
    const applied: Op[] = []; const inverses: Op[] = [];
    for (const op of ops) {
      if (op.type !== 'board' && op.op === 'patch' && isNoopPatch(this.view, op)) continue;
      const inv = invertOp(this.view, op);
      if (!applyOp(this.view, op)) continue;
      applied.push(op);
      if (inv) inverses.unshift(inv);
    }
    if (!applied.length) return false; // JB-1702: an action that changes nothing records no step
    this.view = { ...this.view, fields: new Map(this.view.fields) };
    for (const op of applied) this.pending = foldInto(this.pending, op);
    if (opts.history !== false) this.record(applied, inverses, opts.key ?? null);
    this.notify();
    this.onLocalEdit?.();
    return true;
  }

  private record(ops: Op[], inverses: Op[], key: string | null) {
    const now = Date.now();
    const last = this.undoStack[this.undoStack.length - 1];
    if (key && last && last.key === key && now - last.at < COALESCE_MS) {
      last.ops.push(...ops); last.inverses.unshift(...inverses); last.at = now; // append-only chunks (PERF-23)
    } else {
      this.undoStack.push({ key, at: now, ops, inverses, startTick: this.remoteTick });
      if (this.undoStack.length > HISTORY_MAX) this.undoStack.shift();
    }
    this.redoStack = [];
  }

  get canUndo() { return !this.readOnly && this.undoStack.length > 0; }
  get canRedo() { return !this.readOnly && this.redoStack.length > 0; }

  /** JB-1703: apply the inverse minus every key a collaborator changed since the step began. */
  private replay(step: Step, ops: Op[]): { done: Op[]; inverses: Op[] } {
    const skip = new Set<string>();
    for (const [k, tick] of this.remoteKeys) if (tick > step.startTick) skip.add(k);
    const done: Op[] = []; const inverses: Op[] = [];
    for (const raw of ops) {
      const op = withoutKeys(raw, skip);
      if (!op) continue;
      if (op.type !== 'board') {
        const live = Boolean(getRec(this.view, op.type, op.id));
        if (op.op === 'patch' && !live) continue;  // object deleted remotely: skip
        if (op.op === 'delete' && !live) continue;
        if ((op.op === 'restore' || op.op === 'create') && live) continue;
      }
      const inv = invertOp(this.view, op);
      if (!applyOp(this.view, op)) continue;
      done.push(op); if (inv) inverses.unshift(inv);
    }
    return { done, inverses };
  }

  undo(): 'done' | 'nothing' | 'skipped' {
    if (this.readOnly) return 'nothing';
    const step = this.undoStack.pop();
    if (!step) return 'nothing';
    const { done, inverses } = this.replay(step, step.inverses);
    if (!done.length) { this.notify(); return 'skipped'; } // "Nothing to undo — others have changed these items"
    this.view = { ...this.view, fields: new Map(this.view.fields) };
    for (const op of done) this.pending = foldInto(this.pending, op);
    this.redoStack.push({ key: null, at: Date.now(), ops: done, inverses, startTick: this.remoteTick });
    this.notify(); this.onLocalEdit?.();
    return 'done';
  }

  redo(): 'done' | 'nothing' | 'skipped' {
    if (this.readOnly) return 'nothing';
    const step = this.redoStack.pop();
    if (!step) return 'nothing';
    const { done, inverses } = this.replay(step, step.inverses);
    if (!done.length) { this.notify(); return 'skipped'; }
    this.view = { ...this.view, fields: new Map(this.view.fields) };
    for (const op of done) this.pending = foldInto(this.pending, op);
    this.undoStack.push({ key: null, at: Date.now(), ops: done, inverses, startTick: this.remoteTick });
    this.notify(); this.onLocalEdit?.();
    return 'done';
  }

  // ── sync hooks (driven by BoardSync) ──
  takeForSend(newBatchId: () => string): Inflight | null {
    if (this.inflight || !this.pending.length) return this.inflight;
    this.inflight = { batchId: newBatchId(), ops: this.pending };
    this.pending = [];
    return this.inflight;
  }

  /** Server layer advances strictly in seq order (JB-1502). Returns 'gap' when a batch is missing. */
  applyBatch(b: RemoteBatch): 'applied' | 'stale' | 'gap' {
    if (b.seq <= this.seq) return 'stale';
    if (b.seq !== this.seq + 1) return 'gap';
    const own = b.clientId === this.clientId;
    const touched = new Set<string>();
    const versions = new Map(b.results.map((r) => [objKey(r.type, r.id), r.version]));
    if (!own) this.remoteTick++;
    for (const op of b.ops) {
      applyOp(this.server, op);
      if (op.type === 'board') { touched.add('board'); }
      else {
        touched.add(objKey(op.type, op.id));
        if (!own && op.op === 'delete' && op.type === 'node') this.onRemoteDelete?.(op.id, b.userId);
      }
      if (!own) for (const k of opKeys(op)) this.remoteKeys.set(k, this.remoteTick);
    }
    for (const [k, v] of versions) {
      const [type, id] = [k.slice(0, k.indexOf(':')) as EntityType, k.slice(k.indexOf(':') + 1)];
      const rec = getRec(this.server, type, id);
      if (rec) rec.version = v;
    }
    this.seq = b.seq;
    if (this.inflight?.batchId === b.batchId) this.inflight = null;
    this.recompute(touched);
    return 'applied';
  }

  /** JB-1503: recompute only the touched objects = server state + outbox ops on them, so pending edits stay visible. */
  recompute(touched: Set<string>) {
    if (!touched.size) return;
    const outbox = this.outboxOps();
    const v = this.view;
    for (const key of touched) {
      if (key === 'board') {
        v.name = this.server.name; v.settings = { ...this.server.settings };
        for (const o of outbox) if (o.type === 'board') applyOp(v, o);
        continue;
      }
      const type = key.slice(0, key.indexOf(':')) as EntityType; const id = key.slice(key.indexOf(':') + 1);
      const m = (type === 'node' ? v.nodes : type === 'edge' ? v.edges : v.fields) as Map<string, unknown>;
      const base = getRec(this.server, type, id);
      if (base) m.set(id, structuredClone(base)); else m.delete(id);
      for (const o of outbox) if (o.type === type && o.id === id) applyOp(v, o);
    }
    this.view = { ...v, fields: new Map(v.fields) }; // fields are few; a new map lets field selectors see changes
    this.notify();
  }

  /** After a 409 or 422: replace the inflight ops (rebased or dropped) and recompute what they touched. */
  replaceInflight(ops: Op[] | null) {
    const touched = new Set((this.inflight?.ops ?? []).map((o) => (o.type === 'board' ? 'board' : objKey(o.type, o.id))));
    if (ops && ops.length) {
      let merged: Op[] = [];
      for (const o of [...ops, ...this.pending]) merged = foldInto(merged, o);
      this.pending = merged;
    }
    this.inflight = null;
    this.recompute(touched);
  }

  /** Full resync (410 resync or reconnect after compaction): reload content and keep the outbox on top. */
  resync(c: ContentIn) { this.load(c); }

  setReadOnly(ro: boolean) { if (this.readOnly !== ro) { this.readOnly = ro; this.notify(); } }

  /** Outbox snapshot for persistence (JB-1603). */
  outboxSnapshot() { return { seq: this.seq, inflight: this.inflight, pending: this.pending }; }
  restoreOutbox(s: { inflight: Inflight | null; pending: Op[] }) {
    this.inflight = s.inflight; this.pending = s.pending;
    this.rebuildView();
  }
  discardOutbox() { this.inflight = null; this.pending = []; this.rebuildView(); }

  // ── selectors ──
  node = (id: string) => this.view.nodes.get(id);
  edge = (id: string) => this.view.edges.get(id);
  nodes = () => this.view.nodes;
  fields = () => this.view.fields;
}

/** A create op for a new node of `kind` with registry defaults. */
export function nodeCreate(id: string, kind: string, x: number, y: number, sortKey: string, data: Record<string, unknown>, size?: { width: number; height: number; zIndex?: number }): Op {
  return { type: 'node', op: 'create', id, value: { kind, x, y, sortKey, data, ...(size ? { width: size.width, height: size.height, zIndex: size.zIndex ?? null } : {}) } };
}

export { recFromValue };
