'use client';
// Node components (JB-401, JB-501, JB-601 to JB-603, JB-305). Each reads ITS record and ITS transient
// state through per-node selectors (D-14), so an edit or drag elsewhere does not re-render it.
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo, type ReactNode } from 'react';
import { readDesignCard, readProductCard, readSection, readStats, readText } from '../../kinds';
import { computeStats, freshness, insideSection, readThresholds, STATUS_FIELD_ID } from '../../derive';
import { useBoard, useNodeRec, useReadOnly, useStoreSelect, useUi } from '../context';
import { childrenOf, descendants } from '../actions';
import type { FlowNode } from '../flow';
import { DemandOnCard } from './DemandCard';

export const COLOUR: Record<string, string> = {
  gray: '#6b7280', blue: '#2563eb', violet: '#7c3aed', green: '#15803d', amber: '#b45309', rose: '#be123c',
  cyan: '#0e7490', lime: '#4d7c0f', orange: '#c2410c', teal: '#0f766e',
};
export const colourOf = (c: string) => COLOUR[c] ?? COLOUR.gray;

/** Renders counters per node render; tests and the PT-12 profiler hook read it. */
export const renderCounts = new Map<string, number>();
function useRenderCount(id: string) { renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1); }

const SIDES = [['top', Position.Top], ['right', Position.Right], ['bottom', Position.Bottom], ['left', Position.Left]] as const;
function Handles({ show }: { show: boolean }) {
  return (
    <>
      {SIDES.map(([side, pos]) => (
        <span key={side}>
          <Handle id={`s-${side}`} type="source" position={pos} isConnectable={show} className={show ? 'jb-handle' : 'jb-handle-hidden'} />
          <Handle id={`t-${side}`} type="target" position={pos} isConnectable={show} className="jb-handle-hidden" />
        </span>
      ))}
    </>
  );
}

function useCommon(id: string) {
  useRenderCount(id);
  const dimmed = useUi((s) => s.dimmed.has(id));
  const highlighted = useUi((s) => s.highlighted === id);
  const comments = useUi((s) => s.commentCounts.get(id) ?? 0);
  const readOnly = useReadOnly();
  return { dimmed, highlighted, comments, readOnly };
}

function Frame({ id, children, dimmed, highlighted, selected, className = '', comments }: {
  id: string; children: ReactNode; dimmed: boolean; highlighted: boolean; selected: boolean; className?: string; comments: number;
}) {
  return (
    <div data-node={id} className={`jb-card ${className} ${dimmed ? 'jb-dimmed' : ''} ${highlighted ? 'jb-highlight' : ''} ${selected ? 'jb-selected' : ''}`}>
      {children}
      {comments > 0 && <span className="jb-comment-badge" aria-label={`${comments} comment threads`}>{comments}</span>}
    </div>
  );
}

function StatusPill({ optionId }: { optionId: string }) {
  const opt = useStoreSelect((s) => s.view.fields.get(STATUS_FIELD_ID)?.options.find((o) => o.id === optionId));
  if (!opt) return null;
  return <span className="jb-pill" style={{ borderColor: colourOf(opt.colour), color: colourOf(opt.colour) }}>{opt.label}</span>;
}

const DesignCardNode = memo(function DesignCardNode({ id, selected }: NodeProps<FlowNode>) {
  const rec = useNodeRec(id);
  const { dimmed, highlighted, comments, readOnly } = useCommon(id);
  const settings = useStoreSelect((s) => s.view.settings);
  const shownFields = useStoreSelect((s) => s.view.fields);
  const childCount = useStoreSelect((s) => {
    const n = s.view.nodes.get(id);
    return n && readDesignCard(n.data).collapsed ? descendants(id, childrenOf(s.view.nodes)).length : 0;
  });
  if (!rec) return null;
  const d = readDesignCard(rec.data);
  const fresh = freshness(d, new Date(), readThresholds(settings));
  const extra = [...shownFields.values()].filter((f) => f.showOnCard && f.id !== STATUS_FIELD_ID && d.fieldValues[f.id] !== undefined && d.fieldValues[f.id] !== '');
  return (
    <Frame id={id} dimmed={dimmed} highlighted={highlighted} selected={selected} comments={comments} className={`jb-design ${d.cardSize === 'large' ? 'jb-large' : ''}`}>
      <Handles show={!readOnly} />
      <div className="jb-card-title">{d.title}</div>
      <div className="jb-card-meta">
        <StatusPill optionId={String(d.fieldValues[STATUS_FIELD_ID] ?? '')} />
        {d.area && <span>{d.area}</span>}
        {d.versionTag && <span>{d.versionTag}</span>}
        {d.owner ? <span>{d.owner}</span> : <span className="jb-warn">No owner</span>}
        <span className={`jb-fresh jb-fresh-${fresh}`}>{fresh === 'never' ? 'Never reviewed' : fresh[0].toUpperCase() + fresh.slice(1)}</span>
      </div>
      {extra.length > 0 && (
        <div className="jb-card-fields">
          {extra.map((f) => {
            const v = d.fieldValues[f.id];
            const label = f.kind === 'picker' ? f.options.find((o) => o.id === v)?.label : f.kind === 'toggle' ? (v ? 'Yes' : 'No') : String(v);
            return <span key={f.id}>{f.label}: {label}</span>;
          })}
        </div>
      )}
      {childCount > 0 && <div className="jb-card-children">{childCount} hidden sub-items</div>}
    </Frame>
  );
});

const ProductCardNode = memo(function ProductCardNode({ id, selected }: NodeProps<FlowNode>) {
  const rec = useNodeRec(id);
  const { dimmed, highlighted, comments, readOnly } = useCommon(id);
  if (!rec) return null;
  const p = readProductCard(rec.data);
  return (
    <Frame id={id} dimmed={dimmed} highlighted={highlighted} selected={selected} comments={comments} className="jb-product">
      <Handles show={!readOnly} />
      <div className="jb-product-band">Product</div>
      <div className="jb-card-title">{p.title}</div>
      {p.journeyStage && <div className="jb-quiet">Stage: {p.journeyStage}</div>}
      {p.status && <div className="jb-quiet">Status: {p.status}</div>}
      <DemandOnCard id={id} />{/* JB-503: demand band, target date and attention badge */}
    </Frame>
  );
});

const SectionNode = memo(function SectionNode({ id, selected }: NodeProps<FlowNode>) {
  const rec = useNodeRec(id);
  const dimmed = useUi((s) => s.dimmed.has(id));
  useRenderCount(id);
  if (!rec) return null;
  const s = readSection(rec.data);
  return (
    <div className={`jb-section ${selected ? 'jb-selected' : ''} ${dimmed ? 'jb-dimmed' : ''}`} style={{ borderColor: colourOf(s.color), background: `${colourOf(s.color)}14` }}>
      <div className="jb-section-label" style={{ color: colourOf(s.color) }}>{s.label}</div>
    </div>
  );
});

const TEXT_SIZE: Record<string, string> = { s: '0.8rem', m: '1rem', l: '1.4rem', xl: '2rem' };
const TEXT_FONT: Record<string, string> = { sans: 'inherit', serif: 'Georgia, serif', mono: 'ui-monospace, monospace' };
const TextNode = memo(function TextNode({ id, selected }: NodeProps<FlowNode>) {
  const rec = useNodeRec(id);
  useRenderCount(id);
  if (!rec) return null;
  const t = readText(rec.data);
  return (
    <div className={`jb-text ${selected ? 'jb-selected' : ''}`} style={{ fontSize: TEXT_SIZE[t.size], fontFamily: TEXT_FONT[t.font], fontWeight: t.bold ? 700 : 400, color: colourOf(t.color) }}>
      {t.text || ' '}
    </div>
  );
});

const StatsNode = memo(function StatsNode({ id, selected }: NodeProps<FlowNode>) {
  const rec = useNodeRec(id);
  useRenderCount(id);
  const { store } = useBoard();
  const revision = useStoreSelect((s) => s.revision);
  if (!rec) return null;
  void revision;
  const cfg = readStats(rec.data);
  const nodes = store.view.nodes;
  let cards = [...nodes.values()];
  if (cfg.scope.type === 'section') { const sec = nodes.get(cfg.scope.sectionId); cards = sec ? cards.filter((n) => insideSection(n, sec)) : []; }
  if (cfg.scope.type === 'selection') { const ids = new Set(cfg.scope.nodeIds); cards = cards.filter((n) => ids.has(n.id)); }
  const field = store.view.fields.get(cfg.attributeId);
  const r = computeStats(cards, field, cfg.goalOptionId, cfg.excludedOptionIds);
  return (
    <div className={`jb-card jb-stats ${selected ? 'jb-selected' : ''}`}>
      <div className="jb-card-title">{field?.label ?? 'Statistics'}</div>
      <div className="jb-stats-headline">{r.goalPct === null ? 'No cards yet' : `${r.goalPct}% ${r.goalLabel}`}</div>
      <ul className="jb-stats-rows">
        {r.rows.map((row) => (
          <li key={row.optionId}><span className="jb-dot" style={{ background: colourOf(row.colour) }} />{row.label}<span>{row.count}</span></li>
        ))}
      </ul>
      <div className="jb-quiet">{r.total} Design cards</div>
    </div>
  );
});

/** JB-305: an unknown kind is shown, movable and deletable, and its data is never rewritten. */
const UnsupportedNode = memo(function UnsupportedNode({ id, selected }: NodeProps<FlowNode>) {
  const rec = useNodeRec(id);
  if (!rec) return null;
  return <div className={`jb-card jb-unsupported ${selected ? 'jb-selected' : ''}`}>Unsupported card ({rec.kind})</div>;
});

export const NODE_TYPES = {
  'design-card': DesignCardNode, 'product-card': ProductCardNode, section: SectionNode, text: TextNode, stats: StatsNode,
  unsupported: UnsupportedNode,
};
