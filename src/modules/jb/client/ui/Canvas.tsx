'use client';
// The board canvas (JB-201 to JB-205, JB-701, NFR-04) on React Flow (@xyflow/react).
// Drag positions live in React Flow's own state; the store sees one batch on drag stop (PERF-22, D-16).
import {
  Background, ConnectionMode, Controls, MiniMap, ReactFlow, ViewportPortal, applyNodeChanges, useReactFlow,
  type Connection, type Edge, type NodeChange, type OnNodeDrag,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { STATUS_FIELD_ID } from '../../derive';
import { childrenOf, connect, deleteNodes, DragSession, duplicate, nearestInDirection, nodeLabel, nudge } from '../actions';
import { useBoard, useReadOnly, useStoreSelect, useUi } from '../context';
import { buildEdges, CANVAS_PROPS, FlowNodeCache, hiddenByCollapse, type FlowNode } from '../flow';
import type { Cursor } from '../live';
import { NODE_TYPES } from './nodes';

export interface Pin { id: string; x: number; y: number; resolved: boolean; count: number }

interface Props {
  pins: Pin[];
  cursors: Cursor[];
  onPin: (threadId: string) => void;
  onPointer?: (x: number, y: number) => void;
  onViewport?: (v: { x: number; y: number; zoom: number }) => void;
  initialViewport: { x: number; y: number; zoom: number } | null;
  presentation?: boolean;
}

export default function Canvas({ pins, cursors, onPin, onPointer, onViewport, initialViewport, presentation }: Props) {
  const { store, ui, announce } = useBoard();
  const readOnly = useReadOnly() || Boolean(presentation);
  const revision = useStoreSelect((s) => s.revision);
  const rf = useReactFlow<FlowNode>();
  const cache = useRef(new FlowNodeCache());
  const drag = useRef<{ session: DragSession; anchor: string; x0: number; y0: number } | null>(null);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const focused = useRef<string | null>(null);

  const statusLabel = useCallback((id: string) => store.view.fields.get(STATUS_FIELD_ID)?.options.find((o) => o.id === id)?.label, [store]);

  // Rebuild canvas arrays when the store changes (commits only, never per drag frame). Unchanged nodes keep their objects.
  useEffect(() => {
    const view = store.view;
    const hidden = hiddenByCollapse(view.nodes, childrenOf(view.nodes));
    const built = cache.current.build(view.nodes, hidden, readOnly, (n) => nodeLabel(n, statusLabel));
    setNodes((prev) => {
      const selected = new Set(prev.filter((n) => n.selected).map((n) => n.id));
      const moving = drag.current ? new Map(prev.filter((n) => drag.current!.session.start.has(n.id)).map((n) => [n.id, n.position])) : null;
      if (!selected.size && !moving?.size) return built;
      return built.map((n) => {
        const pos = moving?.get(n.id);
        return selected.has(n.id) || pos ? { ...n, selected: selected.has(n.id), ...(pos ? { position: pos } : {}) } : n;
      });
    });
    setEdges(buildEdges(view.edges, view.nodes, hidden));
  }, [revision, readOnly, store, statusLabel]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
    if (changes.some((c) => c.type === 'select')) {
      queueMicrotask(() => ui.set({ selection: rf.getNodes().filter((n) => n.selected).map((n) => n.id) }));
    }
  }, [rf, ui]);

  const onNodeDragStart: OnNodeDrag<FlowNode> = useCallback((_e, node, dragged) => {
    if (readOnly) return;
    drag.current = { session: new DragSession(store, dragged.map((n) => n.id)), anchor: node.id, x0: node.position.x, y0: node.position.y };
  }, [readOnly, store]);

  const onNodeDrag: OnNodeDrag<FlowNode> = useCallback((_e, node) => {
    const d = drag.current;
    if (!d || node.id !== d.anchor) return;
    const pos = d.session.positions(node.position.x - d.x0, node.position.y - d.y0);
    // Carried nodes (subtree, section members) follow in transient state only.
    setNodes((ns) => ns.map((n) => {
      const p = pos.get(n.id);
      return p && !n.dragging && (n.position.x !== p.x || n.position.y !== p.y) ? { ...n, position: p } : n;
    }));
  }, []);

  const onNodeDragStop: OnNodeDrag<FlowNode> = useCallback((_e, node) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const dx = node.position.x - d.x0, dy = node.position.y - d.y0;
    if (d.session.end(dx, dy)) announce(`${d.session.moving.length} ${d.session.moving.length === 1 ? 'card' : 'cards'} moved`);
  }, [announce]);

  const onConnect = useCallback((c: Connection) => {
    if (readOnly || !c.source || !c.target) return;
    const side = (h: string | null | undefined) => (h ? h.replace(/^[st]-/, '') : null);
    if (connect(store, c.source, c.target, side(c.sourceHandle), side(c.targetHandle))) announce('Connector added');
  }, [readOnly, store, announce]);

  // ── keyboard (NFR-04) ──
  const focusNode = useCallback((id: string) => {
    const n = store.view.nodes.get(id);
    if (!n) return;
    focused.current = id;
    const el = () => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
    if (!el()) void rf.setCenter(n.x + 120, n.y + 60, { zoom: Math.max(rf.getZoom(), 0.6), duration: 0 });
    requestAnimationFrame(() => el()?.focus());
  }, [rf, store]);

  const selectedIds = useCallback(() => rf.getNodes().filter((n) => n.selected).map((n) => n.id), [rf]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const nodeEl = target.closest<HTMLElement>('.react-flow__node');
    const current = nodeEl?.dataset.id ?? focused.current;
    const dirs: Record<string, 'up' | 'down' | 'left' | 'right'> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (e.key in dirs) {
      e.preventDefault();
      if (e.altKey) {
        if (readOnly) return;
        const ids = selectedIds().length ? selectedIds() : current ? [current] : [];
        const step = e.shiftKey ? 1 : 8;
        const [dx, dy] = { up: [0, -step], down: [0, step], left: [-step, 0], right: [step, 0] }[dirs[e.key]];
        const moved = nudge(store, ids, dx, dy);
        if (moved) announce(`${moved} ${moved === 1 ? 'card' : 'cards'} moved`);
        return;
      }
      const from = current ? store.view.nodes.get(current) : [...store.view.nodes.values()][0];
      if (!from) return;
      const next = current ? nearestInDirection(store.view.nodes.values(), from, dirs[e.key]) : from;
      if (next) focusNode(next.id); else announce('No card in that direction');
      return;
    }
    if (e.key === 'Enter' && current) { e.preventDefault(); ui.set({ panelNodeId: current, panelEdgeId: null }); return; }
    if (e.key === 'Escape') { setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n))); ui.set({ panelNodeId: null, panelEdgeId: null, selection: [] }); return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setNodes((ns) => ns.map((n) => ({ ...n, selected: !n.hidden }))); return; }
    if (readOnly) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); const r = e.shiftKey ? store.redo() : store.undo(); if (r === 'skipped') announce('Nothing to undo, others have changed these items'); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); return; }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      const ids = selectedIds().length ? selectedIds() : current ? [current] : [];
      const made = duplicate(store, ids);
      if (made.length) announce(`${made.length} ${made.length === 1 ? 'card' : 'cards'} duplicated`);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const ids = selectedIds().length ? selectedIds() : current ? [current] : [];
      if (!ids.length) return;
      e.preventDefault();
      const kids = childrenOf(store.view.nodes);
      const hasSub = ids.some((i) => (kids.get(i) ?? []).length);
      // JB-806: Keep sub-items or Delete all, both one undo step.
      const mode = hasSub ? (window.confirm('This card has sub-items. OK deletes them too; Cancel keeps them and moves them up.') ? 'all' : 'keep') : 'keep';
      const n = deleteNodes(store, ids, mode);
      if (n) { announce(`${n} ${n === 1 ? 'card' : 'cards'} deleted`); ui.set({ panelNodeId: null, selection: [] }); }
    }
  }, [readOnly, store, ui, announce, focusNode, selectedIds]);

  const edgePanel = useCallback((_: unknown, edge: Edge) => {
    if (!edge.id.startsWith('h:')) ui.set({ panelEdgeId: edge.id, panelNodeId: null });
  }, [ui]);

  const deepFocus = useUi((s) => s.highlighted);
  useEffect(() => { if (deepFocus) { const n = store.view.nodes.get(deepFocus); if (n) void rf.setCenter(n.x + 120, n.y + 60, { zoom: 1, duration: 300 }); } }, [deepFocus, rf, store]);

  const moveEnd = useRef<ReturnType<typeof setTimeout> | null>(null);
  const defaultViewport = useMemo(() => initialViewport ?? undefined, [initialViewport]);

  return (
    <div className="jb-canvas" onKeyDown={onKeyDown}
      onPointerMove={onPointer ? (e) => { const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }); onPointer(p.x, p.y); } : undefined}>
      <ReactFlow<FlowNode>
        {...CANVAS_PROPS}
        nodes={nodes} edges={edges} nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart} onNodeDrag={onNodeDrag} onNodeDragStop={onNodeDragStop}
        onConnect={onConnect} connectionMode={ConnectionMode.Loose}
        onNodeDoubleClick={(_, n) => ui.set({ panelNodeId: n.id, panelEdgeId: null })}
        onNodeClick={(_, n) => { focused.current = n.id; }}
        onEdgeClick={edgePanel}
        onPaneClick={() => ui.set({ panelNodeId: null, panelEdgeId: null })}
        nodesDraggable={!readOnly} nodesConnectable={!readOnly} elementsSelectable
        selectionOnDrag={!readOnly} panOnDrag={readOnly ? true : [1, 2]} selectionKeyCode="Shift" multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        deleteKeyCode={null} zoomOnDoubleClick={false}
        defaultViewport={defaultViewport} fitView={!initialViewport}
        onMoveEnd={(_, v) => { if (!onViewport) return; if (moveEnd.current) clearTimeout(moveEnd.current); moveEnd.current = setTimeout(() => onViewport(v), 1000); }}
        proOptions={{ hideAttribution: true }}
        aria-label="Board canvas. Tab to a card, arrow keys move between cards, Enter opens details, Alt and arrows move cards."
      >
        <Background gap={24} />
        {!presentation && <Controls showInteractive={false} />}
        {!presentation && <MiniMap pannable zoomable ariaLabel="Board overview" />}
        <ViewportPortal>
          {pins.map((p) => (
            <button key={p.id} type="button" className={`jb-pin ${p.resolved ? 'jb-pin-resolved' : ''}`} style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
              onClick={() => onPin(p.id)} aria-label={`Comment thread, ${p.count} ${p.count === 1 ? 'message' : 'messages'}${p.resolved ? ', resolved' : ''}`}>
              {p.count}
            </button>
          ))}
          {cursors.map((c) => (
            <div key={c.userId} className="jb-cursor" style={{ transform: `translate(${c.x}px, ${c.y}px)`, color: c.colour }} aria-hidden>
              <svg width="14" height="14" viewBox="0 0 14 14"><path d="M0 0 L14 5 L6 7 L4 14 Z" fill="currentColor" /></svg>
              <span style={{ background: c.colour }}>{c.name}</span>
            </div>
          ))}
        </ViewportPortal>
      </ReactFlow>
    </div>
  );
}
