'use client';
// NFR-04 outline view: sections and cards as a tree, so everything on a board can be reviewed and opened
// without the canvas. Design cards nest by hierarchy; other cards list under the first section holding them.
import { useMemo } from 'react';
import { readDesignCard, readProductCard, readSection } from '../../kinds';
import { insideSection } from '../../derive';
import type { NodeRec } from '../../ops';
import { childrenOf, nodeLabel } from '../actions';
import { useBoard, useStoreSelect } from '../context';

function title(n: NodeRec) {
  if (n.kind === 'design-card') return readDesignCard(n.data).title;
  if (n.kind === 'product-card') return readProductCard(n.data).title;
  return nodeLabel(n);
}

export default function Outline() {
  const { store, ui } = useBoard();
  const revision = useStoreSelect((s) => s.revision);
  const tree = useMemo(() => {
    void revision;
    const nodes = store.view.nodes;
    const kids = childrenOf(nodes);
    const all = [...nodes.values()].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const sections = all.filter((n) => n.kind === 'section');
    const roots = all.filter((n) => n.kind !== 'section' && !(n.kind === 'design-card' && readDesignCard(n.data).parentId && nodes.has(readDesignCard(n.data).parentId!)));
    const bySection = new Map<string, NodeRec[]>(); const loose: NodeRec[] = [];
    for (const r of roots) {
      const s = sections.find((sec) => insideSection(r, sec));
      if (s) { const l = bySection.get(s.id) ?? []; l.push(r); bySection.set(s.id, l); } else loose.push(r);
    }
    return { sections, bySection, loose, kids, nodes };
  }, [revision, store]);

  const open = (id: string) => ui.set({ panelNodeId: id, highlighted: id });

  const Item = ({ n, depth }: { n: NodeRec; depth: number }) => {
    const children = (tree.kids.get(n.id) ?? []).map((c) => tree.nodes.get(c)!).filter(Boolean);
    return (
      <li role="treeitem" aria-level={depth} aria-expanded={children.length ? true : undefined} aria-selected={false}>
        <button type="button" className="jb-outline-item" onClick={() => open(n.id)} aria-label={`${nodeLabel(n)}. Open details`}>
          <span className={`jb-kind jb-kind-${n.kind}`}>{n.kind === 'design-card' ? 'Design' : n.kind === 'product-card' ? 'Product' : n.kind}</span> {title(n)}
        </button>
        {children.length > 0 && <ul role="group">{children.map((c) => <Item key={c.id} n={c} depth={depth + 1} />)}</ul>}
      </li>
    );
  };

  return (
    <nav className="jb-outline" aria-label="Board outline">
      <h2>Outline</h2>
      <ul role="tree" aria-label="Sections and cards">
        {tree.sections.map((s) => (
          <li key={s.id} role="treeitem" aria-level={1} aria-expanded aria-selected={false}>
            <button type="button" className="jb-outline-item jb-outline-section" onClick={() => open(s.id)}>Section: {readSection(s.data).label}</button>
            <ul role="group">{(tree.bySection.get(s.id) ?? []).map((n) => <Item key={n.id} n={n} depth={2} />)}</ul>
          </li>
        ))}
        {tree.loose.map((n) => <Item key={n.id} n={n} depth={1} />)}
        {!tree.nodes.size && <li className="jb-quiet">This board is empty.</li>}
      </ul>
    </nav>
  );
}
