'use client';
// Details panel (JB-402, JB-404, JB-502, JB-602, JB-603, JB-701). Every edit is one node.patch that sets
// updatedAt; typing in one field coalesces into one undo step (JB-1702). Read-only viewers get text, no inputs (JB-207).
import { useEffect, useState, type ReactNode } from 'react';
import { getKind, readDesignCard, readProductCard, readSection, readStats, readText, SECTION_COLOURS, TEXT_FONTS, TEXT_SIZES } from '../../kinds';
import { effectiveArea, STATUS_FIELD_ID } from '../../derive';
import type { FieldRec, NodeRec } from '../../ops';
import { safeUrl, SAFE_LINK_REL } from '@/lib/text';
import { assignParent, childrenOf, deleteNodes, markReviewed, newLocalId, patchCard, setFieldValue } from '../actions';
import { useBoard, useNodeRec, useReadOnly, useStoreSelect, useUi } from '../context';
import { uploadBoardImages } from '../uploads';

/** P5 extension point (JB-502): sections the Feedback Hub integration adds to the Product card panel. */
export type PanelSlot = (props: { node: NodeRec; boardId: string; readOnly: boolean }) => ReactNode;
export const productPanelSlots: PanelSlot[] = [];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="jb-row"><span className="jb-row-label">{label}</span><div className="jb-row-value">{children}</div></div>;
}

function TextField({ id, label, value, onChange, readOnly, multiline, max = 200 }: {
  id: string; label: string; value: string; onChange: (v: string) => void; readOnly: boolean; multiline?: boolean; max?: number;
}) {
  if (readOnly) return <Row label={label}>{value || <span className="jb-quiet">None</span>}</Row>;
  return (
    <label className="jb-field" htmlFor={id}>
      <span className="jb-row-label">{label}</span>
      {multiline
        ? <textarea id={id} value={value} maxLength={max} rows={3} onChange={(e) => onChange(e.target.value)} />
        : <input id={id} value={value} maxLength={max} onChange={(e) => onChange(e.target.value)} />}
    </label>
  );
}

function FieldValue({ node, field, readOnly }: { node: NodeRec; field: FieldRec; readOnly: boolean }) {
  const { store } = useBoard();
  const v = readDesignCard(node.data).fieldValues[field.id];
  const fid = `fv-${node.id}-${field.id}`;
  if (readOnly) {
    const shown = field.kind === 'picker' ? field.options.find((o) => o.id === v)?.label : field.kind === 'toggle' ? (v ? 'Yes' : 'No') : v ? String(v) : '';
    return <Row label={field.label}>{shown || <span className="jb-quiet">None</span>}</Row>;
  }
  const set = (val: unknown) => setFieldValue(store, node.id, field.id, val);
  return (
    <label className="jb-field" htmlFor={fid}>
      <span className="jb-row-label">{field.label}</span>
      {field.kind === 'picker' && (
        <select id={fid} value={typeof v === 'string' ? v : ''} onChange={(e) => set(e.target.value || null)}>
          <option value="">None</option>
          {field.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      )}
      {field.kind === 'text' && <input id={fid} value={typeof v === 'string' ? v : ''} maxLength={500} onChange={(e) => set(e.target.value)} />}
      {field.kind === 'date' && <input id={fid} type="date" value={typeof v === 'string' ? v : ''} onChange={(e) => set(e.target.value || null)} />}
      {field.kind === 'toggle' && <input id={fid} type="checkbox" checked={v === true} onChange={(e) => set(e.target.checked)} />}
    </label>
  );
}

function Links({ node, readOnly }: { node: NodeRec; readOnly: boolean }) {
  const { store } = useBoard();
  const links = readDesignCard(node.data).links;
  const [label, setLabel] = useState(''); const [url, setUrl] = useState(''); const [err, setErr] = useState('');
  return (
    <section aria-label="Links">
      <h3>Links</h3>
      <ul className="jb-links">
        {links.map((l, i) => {
          const safe = safeUrl(l.url);
          return (
            <li key={i}>
              {safe ? <a href={safe} target="_blank" rel={SAFE_LINK_REL}>{l.label || safe}</a> : <span>{l.label} {l.url}</span>}
              {!readOnly && <button type="button" onClick={() => patchCard(store, node.id, { links: links.filter((_, k) => k !== i) })} aria-label={`Remove link ${l.label || l.url}`}>Remove</button>}
            </li>
          );
        })}
        {!links.length && <li className="jb-quiet">No links yet</li>}
      </ul>
      {!readOnly && (
        <form className="jb-inline-form" onSubmit={(e) => {
          e.preventDefault();
          const safe = safeUrl(url.trim());
          if (!safe) { setErr('Links must start with http:// or https://'); return; }
          patchCard(store, node.id, { links: [...links, { label: label.trim(), url: safe }] });
          setLabel(''); setUrl(''); setErr('');
        }}>
          <input aria-label="Link label" placeholder="Label" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
          <input aria-label="Link address" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} aria-describedby={err ? `lerr-${node.id}` : undefined} />
          <button type="submit">Add link</button>
          {err && <p id={`lerr-${node.id}`} role="alert" className="jb-error">{err}</p>}
        </form>
      )}
    </section>
  );
}

function Comparison({ node, readOnly }: { node: NodeRec; readOnly: boolean }) {
  const { store, boardId, imageUrl, requestImages, mode } = useBoard();
  const cmp = readDesignCard(node.data).comparison;
  const [busy, setBusy] = useState(''); const [err, setErr] = useState('');
  const ids = [cmp.previousImageId, cmp.currentImageId].filter(Boolean) as string[];
  useEffect(() => { if (ids.length) requestImages(ids); }, [ids.join(','), requestImages]); // eslint-disable-line react-hooks/exhaustive-deps
  const upload = async (slot: 'previousImageId' | 'currentImageId', file: File) => {
    const imageId = newLocalId();
    setBusy('Uploading…'); setErr('');
    const [r] = await uploadBoardImages(boardId, [{ imageId, file, name: file.name }]);
    setBusy('');
    if (r.status === 'rejected') { setErr(String((r.reason as Error).message)); return; }
    patchCard(store, node.id, { comparison: { ...cmp, [slot]: imageId } });
    requestImages([imageId]);
  };
  return (
    <section aria-label="Comparison">
      <h3>Comparison</h3>
      <div className="jb-compare">
        {(['previousImageId', 'currentImageId'] as const).map((slot) => {
          const id = cmp[slot];
          const src = id ? imageUrl(id) : undefined;
          return (
            <figure key={slot}>
              {src ? <a href={src} target="_blank" rel={SAFE_LINK_REL}>{/* Signed storage URLs: next/image would proxy them through the app origin (SEC-29). */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={slot === 'previousImageId' ? 'Previous screenshot' : 'Current screenshot'} /></a>
                : <div className="jb-img-empty">{id ? 'Loading…' : 'No screenshot'}</div>}
              <figcaption>{slot === 'previousImageId' ? 'Previous' : 'Current'}</figcaption>
              {!readOnly && mode === 'collab' && (
                <label className="jb-upload">Upload<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(slot, f); e.target.value = ''; }} /></label>
              )}
            </figure>
          );
        })}
      </div>
      {busy && <p role="status">{busy}</p>}
      {err && <p role="alert" className="jb-error">{err}</p>}
    </section>
  );
}

function DesignPanel({ node, readOnly }: { node: NodeRec; readOnly: boolean }) {
  const { store, ui, me } = useBoard();
  const d = readDesignCard(node.data);
  const fields = useStoreSelect((s) => s.view.fields);
  const showSummary = useStoreSelect((s) => s.view.settings.showChangeSummary === true);
  const others = useStoreSelect((s) => s.revision);
  void others;
  const cards = [...store.view.nodes.values()].filter((n) => n.kind === 'design-card' && n.id !== node.id);
  const kids = childrenOf(store.view.nodes).get(node.id) ?? [];
  const p = (data: Record<string, unknown>) => patchCard(store, node.id, data);
  return (
    <>
      <TextField id={`t-${node.id}`} label="Title" value={d.title} onChange={(v) => p({ title: v })} readOnly={readOnly} />
      <TextField id={`d-${node.id}`} label="Description" value={d.description} onChange={(v) => p({ description: v })} readOnly={readOnly} multiline max={10_000} />
      <TextField id={`a-${node.id}`} label="Area" value={d.area} onChange={(v) => p({ area: v })} readOnly={readOnly} max={120} />
      {!d.area && d.parentId && <p className="jb-quiet">Effective area: {effectiveArea(node.id, (x) => store.view.nodes.get(x)) || 'none'}</p>}
      <TextField id={`v-${node.id}`} label="Version" value={d.versionTag} onChange={(v) => p({ versionTag: v })} readOnly={readOnly} max={60} />
      <TextField id={`o-${node.id}`} label="Owner" value={d.owner} onChange={(v) => p({ owner: v })} readOnly={readOnly} max={120} />
      <TextField id={`tm-${node.id}`} label="Team" value={d.team} onChange={(v) => p({ team: v })} readOnly={readOnly} max={120} />
      <h3>Fields</h3>
      {[...fields.values()].sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1)).map((f) => <FieldValue key={f.id} node={node} field={f} readOnly={readOnly} />)}
      <Row label="Reviewed">{d.reviewedAt ? `${new Date(d.reviewedAt).toLocaleDateString('en-GB')} by ${d.reviewedBy ?? 'someone'}` : 'Never'}</Row>
      <Row label="Updated">{d.updatedAt ? new Date(d.updatedAt).toLocaleDateString('en-GB') : 'Unknown'}</Row>
      {!readOnly && (
        <div className="jb-actions">
          <button type="button" onClick={() => markReviewed(store, [node.id], me?.name ?? 'Someone')}>Mark reviewed</button>
          <button type="button" onClick={() => p({ collapsed: !d.collapsed })} disabled={!kids.length}>{d.collapsed ? 'Expand sub-items' : 'Collapse sub-items'}</button>
          <button type="button" onClick={() => p({ cardSize: d.cardSize === 'large' ? 'normal' : 'large' })}>{d.cardSize === 'large' ? 'Normal size' : 'Large size'}</button>
          <label className="jb-check"><input type="checkbox" checked={d.excludeFromStats} onChange={(e) => p({ excludeFromStats: e.target.checked })} /> Leave out of statistics</label>
          <label className="jb-field">
            <span className="jb-row-label">Parent</span>
            <select value={d.parentId ?? ''} onChange={(e) => {
              const parent = e.target.value || null;
              const inherit = parent ? window.confirm('Should this card inherit the parent\'s area? OK clears its own area; Cancel keeps it.') : false;
              if (!assignParent(store, [node.id], parent, inherit)) window.alert('A card cannot be its own ancestor.');
            }}>
              <option value="">No parent</option>
              {cards.map((c) => <option key={c.id} value={c.id}>{readDesignCard(c.data).title}</option>)}
            </select>
          </label>
          <button type="button" className="jb-danger" onClick={() => { deleteNodes(store, [node.id], 'keep'); ui.set({ panelNodeId: null }); }}>Delete card</button>
        </div>
      )}
      <Comparison node={node} readOnly={readOnly} />
      {showSummary && (
        <section aria-label="Change summary">
          <h3>Change summary</h3>
          {(['problem', 'ux', 'ui', 'gaps', 'notes'] as const).map((k) => (
            <TextField key={k} id={`cs-${k}-${node.id}`} label={{ problem: 'Problem', ux: 'UX', ui: 'UI', gaps: 'Gaps', notes: 'Notes' }[k]}
              value={d.changeSummary[k] ?? ''} onChange={(v) => p({ changeSummary: { ...d.changeSummary, [k]: v } })} readOnly={readOnly} multiline max={2000} />
          ))}
        </section>
      )}
      <Links node={node} readOnly={readOnly} />
    </>
  );
}

function ProductPanel({ node, readOnly }: { node: NodeRec; readOnly: boolean }) {
  const { store, boardId, ui } = useBoard();
  const d = readProductCard(node.data);
  useStoreSelect((s) => s.revision);
  const p = (data: Record<string, unknown>) => patchCard(store, node.id, data);
  const linked = new Map<string, string>();
  for (const e of store.view.edges.values()) {
    const other = e.source === node.id ? e.target : e.target === node.id ? e.source : null;
    const n = other ? store.view.nodes.get(other) : null;
    if (n?.kind === 'design-card') linked.set(n.id, readDesignCard(n.data).title);
  }
  return (
    <>
      <TextField id={`t-${node.id}`} label="Title" value={d.title} onChange={(v) => p({ title: v })} readOnly={readOnly} />
      <TextField id={`d-${node.id}`} label="Description" value={d.description} onChange={(v) => p({ description: v })} readOnly={readOnly} multiline max={10_000} />
      <TextField id={`o-${node.id}`} label="Owner" value={d.owner} onChange={(v) => p({ owner: v })} readOnly={readOnly} max={120} />
      <TextField id={`j-${node.id}`} label="Journey stage" value={d.journeyStage} onChange={(v) => p({ journeyStage: v })} readOnly={readOnly} max={120} />
      <TextField id={`s-${node.id}`} label="Status" value={d.status} onChange={(v) => p({ status: v })} readOnly={readOnly} max={120} />
      {productPanelSlots.map((Slot, i) => <div key={i}>{Slot({ node, boardId, readOnly })}</div>)}
      <section aria-label="Design cards">
        <h3>Design cards</h3>
        <ul>{[...linked].map(([id, title]) => <li key={id}><button type="button" className="jb-link" onClick={() => ui.set({ panelNodeId: id, highlighted: id })}>{title}</button></li>)}
          {!linked.size && <li className="jb-quiet">No connected Design cards</li>}</ul>
      </section>
      <Links node={node} readOnly={readOnly} />
      {!readOnly && <button type="button" className="jb-danger" onClick={() => { deleteNodes(store, [node.id]); ui.set({ panelNodeId: null }); }}>Delete card</button>}
    </>
  );
}

function SimplePanel({ node, readOnly }: { node: NodeRec; readOnly: boolean }) {
  const { store, ui } = useBoard();
  const fields = useStoreSelect((s) => s.view.fields);
  const sections = useStoreSelect((s) => s.revision) && [...store.view.nodes.values()].filter((n) => n.kind === 'section');
  const p = (data: Record<string, unknown>) => patchCard(store, node.id, data, { touch: false });
  const del = !readOnly && <button type="button" className="jb-danger" onClick={() => { deleteNodes(store, [node.id]); ui.set({ panelNodeId: null }); }}>Delete</button>;
  if (node.kind === 'section') {
    const s = readSection(node.data);
    return (<>
      <TextField id={`l-${node.id}`} label="Label" value={s.label} onChange={(v) => p({ label: v })} readOnly={readOnly} />
      {!readOnly && <label className="jb-field"><span className="jb-row-label">Colour</span><select value={s.color} onChange={(e) => p({ color: e.target.value })}>{SECTION_COLOURS.map((c) => <option key={c}>{c}</option>)}</select></label>}
      {!readOnly && <Row label="Size"><input aria-label="Width" type="number" min={24} value={node.width ?? 480} onChange={(e) => store.edit([{ type: 'node', op: 'patch', id: node.id, set: { width: Math.max(24, Number(e.target.value)) } }], { key: `node:${node.id}:size` })} />
        <input aria-label="Height" type="number" min={24} value={node.height ?? 320} onChange={(e) => store.edit([{ type: 'node', op: 'patch', id: node.id, set: { height: Math.max(24, Number(e.target.value)) } }], { key: `node:${node.id}:size` })} /></Row>}
      {del}
    </>);
  }
  if (node.kind === 'text') {
    const t = readText(node.data);
    return (<>
      <TextField id={`x-${node.id}`} label="Text" value={t.text} onChange={(v) => p({ text: v })} readOnly={readOnly} multiline max={2000} />
      {!readOnly && <>
        <label className="jb-field"><span className="jb-row-label">Size</span><select value={t.size} onChange={(e) => p({ size: e.target.value })}>{TEXT_SIZES.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="jb-field"><span className="jb-row-label">Font</span><select value={t.font} onChange={(e) => p({ font: e.target.value })}>{TEXT_FONTS.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="jb-field"><span className="jb-row-label">Colour</span><select value={t.color} onChange={(e) => p({ color: e.target.value })}>{SECTION_COLOURS.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="jb-check"><input type="checkbox" checked={t.bold} onChange={(e) => p({ bold: e.target.checked })} /> Bold</label>
      </>}
      {del}
    </>);
  }
  if (node.kind === 'stats') {
    const st = readStats(node.data);
    const pickers = [...fields.values()].filter((f) => f.kind === 'picker');
    const attr = fields.get(st.attributeId);
    return (<>
      {readOnly ? <Row label="Counts">{attr?.label ?? 'Design status'}</Row> : <>
        <label className="jb-field"><span className="jb-row-label">Attribute</span><select value={st.attributeId} onChange={(e) => p({ attributeId: e.target.value })}>{pickers.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></label>
        <label className="jb-field"><span className="jb-row-label">Goal</span><select value={st.goalOptionId} onChange={(e) => p({ goalOptionId: e.target.value })}>{(attr?.options ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
        <label className="jb-field"><span className="jb-row-label">Scope</span><select value={st.scope.type === 'section' ? `section:${st.scope.sectionId}` : st.scope.type}
          onChange={(e) => { const v = e.target.value; p({ scope: v.startsWith('section:') ? { type: 'section', sectionId: v.slice(8) } : v === 'selection' ? { type: 'selection', nodeIds: ui.state.selection } : { type: 'board' } }); }}>
          <option value="board">Whole board</option>
          {(sections || []).map((s) => <option key={s.id} value={`section:${s.id}`}>Section: {readSection(s.data).label}</option>)}
          <option value="selection">Current selection</option>
        </select></label>
        <fieldset><legend>Leave out</legend>{(attr?.options ?? []).map((o) => (
          <label key={o.id} className="jb-check"><input type="checkbox" checked={st.excludedOptionIds.includes(o.id)}
            onChange={(e) => p({ excludedOptionIds: e.target.checked ? [...st.excludedOptionIds, o.id] : st.excludedOptionIds.filter((x) => x !== o.id) })} /> {o.label}</label>
        ))}</fieldset>
      </>}
      {del}
    </>);
  }
  return <p>This card type is not supported by this version of the app. It can be moved or deleted, and its data is kept.</p>;
}

export function EdgePanel({ id }: { id: string }) {
  const { store, ui } = useBoard();
  const e = useStoreSelect((s) => s.view.edges.get(id));
  const readOnly = useReadOnly();
  if (!e) return null;
  const label = typeof e.data.label === 'string' ? e.data.label : '';
  return (
    <aside className="jb-panel" aria-label="Connector details">
      <header><h2>Connector</h2><button type="button" onClick={() => ui.set({ panelEdgeId: null })} aria-label="Close">Close</button></header>
      {readOnly ? <Row label="Label">{label || 'None'}</Row> : <>
        <TextField id={`el-${id}`} label="Label" value={label} readOnly={false} onChange={(v) => store.edit([{ type: 'edge', op: 'patch', id, data: { label: v } }], { key: `edge:${id}:label` })} />
        <label className="jb-check"><input type="checkbox" checked={e.data.directed !== false} onChange={(ev) => store.edit([{ type: 'edge', op: 'patch', id, data: { directed: ev.target.checked } }])} /> Arrow (directed)</label>
        <button type="button" onClick={() => store.edit([{ type: 'edge', op: 'patch', id, set: { source: e.target, target: e.source } }])}>Reverse</button>
        <button type="button" className="jb-danger" onClick={() => { store.edit([{ type: 'edge', op: 'delete', id }]); ui.set({ panelEdgeId: null }); }}>Delete connector</button>
      </>}
    </aside>
  );
}

export default function Panel({ id, comments }: { id: string; comments?: ReactNode }) {
  const node = useNodeRec(id);
  const readOnly = useReadOnly();
  const { ui } = useBoard();
  const notice = useUi((s) => s.deletedNotice);
  if (!node) {
    return (
      <aside className="jb-panel" aria-label="Card details">
        <p role="status">{notice ?? 'That card no longer exists.'}</p>
        <button type="button" onClick={() => ui.set({ panelNodeId: null, deletedNotice: null })}>Close</button>
      </aside>
    );
  }
  const title = getKind(node.kind)?.label ?? 'Unsupported card';
  return (
    <aside className="jb-panel" aria-label={`${title} details`}>
      <header><h2>{title}</h2><button type="button" onClick={() => ui.set({ panelNodeId: null })}>Close</button></header>
      {readOnly && <p className="jb-quiet">View only</p>}
      {node.kind === 'design-card' ? <DesignPanel node={node} readOnly={readOnly} />
        : node.kind === 'product-card' ? <ProductPanel node={node} readOnly={readOnly} />
          : <SimplePanel node={node} readOnly={readOnly} />}
      {comments}
    </aside>
  );
}

export { STATUS_FIELD_ID };
