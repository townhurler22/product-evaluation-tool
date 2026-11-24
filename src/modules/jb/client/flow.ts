// Store → canvas mapping (PERF-21, PERF-23, D-14, D-17). Incremental: a node whose record did not change
// keeps the same canvas object, so React Flow and memoised node components skip it.
import type { Edge, Node } from '@xyflow/react';
import { getKind, readDesignCard } from '../kinds';
import type { EdgeRec, NodeRec } from '../ops';

export type FlowNode = Node<{ id: string }>;
export const UNSUPPORTED = 'unsupported';

/** The props that matter for performance and access, shared with tests (D-17). */
export const CANVAS_PROPS = {
  onlyRenderVisibleElements: true,
  disableKeyboardA11y: true, // NFR-04 keys are handled by the board (arrows move focus, Alt+arrows move)
  nodesFocusable: true,
  elevateNodesOnSelect: false,
  minZoom: 0.05,
  maxZoom: 4,
} as const;

interface CacheEntry { rec: NodeRec; hidden: boolean; readOnly: boolean; label: string; node: FlowNode }

export class FlowNodeCache {
  private cache = new Map<string, CacheEntry>();
  private lastArray: FlowNode[] = [];

  /** Hidden = a collapsed ancestor (JB-805). Computed from the hierarchy maintained once per store change. */
  build(nodes: Map<string, NodeRec>, hidden: Set<string>, readOnly: boolean, label: (n: NodeRec) => string): FlowNode[] {
    let changed = nodes.size !== this.cache.size;
    const out: FlowNode[] = [];
    const seen = new Set<string>();
    for (const rec of nodes.values()) {
      seen.add(rec.id);
      const h = hidden.has(rec.id);
      const prev = this.cache.get(rec.id);
      if (prev && prev.rec === rec && prev.hidden === h && prev.readOnly === readOnly) { out.push(prev.node); continue; }
      changed = true;
      const def = getKind(rec.kind);
      const lbl = label(rec);
      const node: FlowNode = {
        id: rec.id,
        type: def ? rec.kind : UNSUPPORTED, // JB-305: unknown kinds render as "Unsupported card"
        position: { x: rec.x, y: rec.y },
        data: { id: rec.id },
        hidden: h,
        draggable: !readOnly,
        connectable: !readOnly && (rec.kind === 'design-card' || rec.kind === 'product-card'),
        deletable: false, // deletes go through the board so connectors and sub-items are handled (JB-806)
        ariaLabel: lbl,
        ...(rec.zIndex !== null ? { zIndex: rec.zIndex } : {}),
        ...(rec.width && rec.height ? { width: rec.width, height: rec.height, style: { width: rec.width, height: rec.height } } : {}),
      };
      this.cache.set(rec.id, { rec, hidden: h, readOnly, label: lbl, node });
      out.push(node);
    }
    for (const id of [...this.cache.keys()]) if (!seen.has(id)) { this.cache.delete(id); changed = true; }
    if (!changed) return this.lastArray;
    // Sections first so they sit behind cards.
    out.sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
    this.lastArray = out;
    return out;
  }
}

/** Hidden ids: descendants of collapsed Design cards (JB-805). */
export function hiddenByCollapse(nodes: Map<string, NodeRec>, kids: Map<string, string[]>): Set<string> {
  const hidden = new Set<string>();
  for (const n of nodes.values()) {
    if (n.kind !== 'design-card' || !readDesignCard(n.data).collapsed) continue;
    const stack = [...(kids.get(n.id) ?? [])];
    while (stack.length) { const c = stack.pop()!; if (hidden.has(c)) continue; hidden.add(c); stack.push(...(kids.get(c) ?? [])); }
  }
  return hidden;
}

const sideHandle = (h: unknown) => (typeof h === 'string' && /^(top|right|bottom|left)$/.test(h) ? h : undefined);

/** Connectors plus derived hierarchy lines (JB-801: drawn, never stored). */
export function buildEdges(edges: Map<string, EdgeRec>, nodes: Map<string, NodeRec>, hidden: Set<string>): Edge[] {
  const out: Edge[] = [];
  for (const e of edges.values()) {
    const label = typeof e.data.label === 'string' ? e.data.label : '';
    out.push({
      id: e.id, source: e.source, target: e.target, label: label || undefined,
      sourceHandle: sideHandle(e.data.sourceHandle) ? `s-${e.data.sourceHandle}` : undefined,
      targetHandle: sideHandle(e.data.targetHandle) ? `t-${e.data.targetHandle}` : undefined,
      hidden: hidden.has(e.source) || hidden.has(e.target),
      markerEnd: e.data.directed === false ? undefined : { type: 'arrowclosed' as never },
      deletable: false,
      ariaLabel: `Connector${label ? ` "${label}"` : ''}`,
    });
  }
  for (const n of nodes.values()) {
    if (n.kind !== 'design-card') continue;
    const p = readDesignCard(n.data).parentId;
    if (!p || !nodes.has(p)) continue;
    out.push({
      id: `h:${n.id}`, source: p, target: n.id, sourceHandle: 's-bottom', targetHandle: 't-top', type: 'smoothstep',
      selectable: false, focusable: false, deletable: false, hidden: hidden.has(n.id),
      style: { strokeDasharray: '4 4', stroke: 'var(--muted)' }, className: 'jb-hierarchy',
    });
  }
  return out;
}
