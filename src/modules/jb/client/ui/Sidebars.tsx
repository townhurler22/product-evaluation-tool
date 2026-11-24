'use client';
// Filters (JB-1001/1002), health, lookahead and isolate mode with a review rail (JB-1003, JB-1101 to JB-1103),
// and the fields manager (JB-901, JB-902). Filters are per user and never saved to the board.
import { useEffect, useMemo, useState } from 'react';
import { readDesignCard } from '../../kinds';
import {
  boardHealth, filtersActive, lookahead, LOOKAHEAD_LABELS, matchesFilters, readThresholds, todayNumber, FIELD_COLOURS,
  STATUS_FIELD_ID, type Freshness, type LookaheadBucket,
} from '../../derive';
import type { FieldRec, Op } from '../../ops';
import { keyBetween } from '../../sortkey';
import { FIELD_PRESETS } from '../../template';
import { markReviewed, newLocalId } from '../actions';
import { useBoard, useReadOnly, useStoreSelect, useUi } from '../context';
import { colourOf } from './nodes';

/** Keeps the dimmed set in step with filters and isolate mode (per-node selectors read it). */
export function useDimming() {
  const { store, ui } = useBoard();
  const revision = useStoreSelect((s) => s.revision);
  const filters = useUi((s) => s.filters);
  const isolate = useUi((s) => s.isolate);
  useEffect(() => {
    const t = readThresholds(store.view.settings);
    const now = new Date();
    const dim = new Set<string>();
    const cohort = isolate ? new Set(isolate.ids) : null;
    const active = filtersActive(filters);
    for (const n of store.view.nodes.values()) {
      if (n.kind === 'section') continue;
      if (cohort ? !cohort.has(n.id) : active && !matchesFilters(n, filters, now, t)) dim.add(n.id);
    }
    ui.setDimmed(dim);
  }, [revision, filters, isolate, store, ui]);
}

export function FiltersPanel() {
  const { store, ui } = useBoard();
  const filters = useUi((s) => s.filters);
  const fields = useStoreSelect((s) => s.view.fields);
  const revision = useStoreSelect((s) => s.revision);
  const { owners, total, matching } = useMemo(() => {
    void revision;
    const t = readThresholds(store.view.settings); const now = new Date();
    const cards = [...store.view.nodes.values()].filter((n) => n.kind === 'design-card');
    return {
      owners: [...new Set(cards.map((n) => readDesignCard(n.data).owner).filter(Boolean))].sort(),
      total: cards.length, matching: cards.filter((n) => matchesFilters(n, filters, now, t)).length,
    };
  }, [revision, filters, store]);
  const set = (patch: Partial<typeof filters>) => ui.set({ filters: { ...filters, ...patch } });
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <section className="jb-side" aria-label="Filters">
      <h2>Filters</h2>
      <p role="status">{matching} of {total} cards</p>
      <label className="jb-field"><span className="jb-row-label">Search</span><input value={filters.text} onChange={(e) => set({ text: e.target.value })} /></label>
      {[...fields.values()].filter((f) => f.kind === 'picker').map((f) => (
        <fieldset key={f.id}><legend>{f.label}</legend>
          {f.options.map((o) => (
            <label key={o.id} className="jb-check"><input type="checkbox" checked={(filters.options[f.id] ?? []).includes(o.id)}
              onChange={() => set({ options: { ...filters.options, [f.id]: toggle(filters.options[f.id] ?? [], o.id) } })} /> {o.label}</label>
          ))}
        </fieldset>
      ))}
      <fieldset><legend>Freshness</legend>
        {(['fresh', 'aging', 'stale', 'never'] as Freshness[]).map((f) => (
          <label key={f} className="jb-check"><input type="checkbox" checked={filters.freshness.includes(f)} onChange={() => set({ freshness: toggle(filters.freshness, f) })} /> {f === 'never' ? 'Never reviewed' : f[0].toUpperCase() + f.slice(1)}</label>
        ))}
      </fieldset>
      <fieldset><legend>Owner</legend>
        <label className="jb-check"><input type="checkbox" checked={filters.missingOwner} onChange={(e) => set({ missingOwner: e.target.checked })} /> Missing owner</label>
        {owners.map((o) => <label key={o} className="jb-check"><input type="checkbox" checked={filters.owners.includes(o)} onChange={() => set({ owners: toggle(filters.owners, o) })} /> {o}</label>)}
      </fieldset>
      <button type="button" onClick={() => ui.set({ filters: { options: {}, owners: [], freshness: [], missingOwner: false, text: '' } })}>Clear filters</button>
    </section>
  );
}

export function HealthPanel() {
  const { store, ui, me, announce } = useBoard();
  const revision = useStoreSelect((s) => s.revision);
  const readOnly = useReadOnly();
  const isolate = useUi((s) => s.isolate);
  const data = useMemo(() => {
    void revision;
    const t = readThresholds(store.view.settings);
    const now = new Date();
    const cards = [...store.view.nodes.values()].filter((n) => n.kind === 'design-card');
    const h = boardHealth(cards, store.view.fields.get(STATUS_FIELD_ID), now, t);
    const la = (store.view.settings.lookahead ?? {}) as { fieldId?: string; horizonWeeks?: number };
    const buckets = new Map<LookaheadBucket, string[]>();
    if (la.fieldId) for (const n of cards) {
      const b = lookahead(readDesignCard(n.data).fieldValues[la.fieldId], todayNumber(now), la.horizonWeeks ?? 4);
      buckets.set(b, [...(buckets.get(b) ?? []), n.id]);
    }
    return { h, buckets, laField: la.fieldId ? store.view.fields.get(la.fieldId)?.label : null };
  }, [revision, store]);
  const start = (label: string, ids: string[]) => {
    if (!ids.length) return;
    ui.set({ isolate: { label, ids, index: 0 }, panelNodeId: ids[0], highlighted: ids[0] });
    announce(`Reviewing ${ids.length} cards: ${label}`);
  };
  const rows: [string, string[] | null][] = [
    ['Stale', data.h.stale], ['Never reviewed', data.h.never], ['No owner', data.h.noOwner], ['Not assessed', data.h.notAssessed], ['No links', data.h.noLinks],
  ];
  const step = (d: number) => {
    if (!isolate) return;
    const index = (isolate.index + d + isolate.ids.length) % isolate.ids.length;
    ui.set({ isolate: { ...isolate, index }, panelNodeId: isolate.ids[index], highlighted: isolate.ids[index] });
  };
  return (
    <section className="jb-side" aria-label="Board health" onKeyDown={(e) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.key === 'j') step(1); if (e.key === 'k') step(-1);
    }}>
      <h2>Board health</h2>
      {isolate ? (
        <div className="jb-rail" aria-label="Review rail">
          <p>{isolate.label}: card {isolate.index + 1} of {isolate.ids.length}. Press J and K to step.</p>
          <div className="jb-actions">
            <button type="button" onClick={() => step(-1)}>Previous (K)</button>
            <button type="button" onClick={() => step(1)}>Next (J)</button>
            {!readOnly && <button type="button" onClick={() => { markReviewed(store, [isolate.ids[isolate.index]], me?.name ?? 'Someone'); announce('Marked reviewed'); }}>Mark reviewed</button>}
            <button type="button" onClick={() => ui.set({ isolate: null, highlighted: null })}>Exit review</button>
          </div>
        </div>
      ) : (
        <ul className="jb-health">
          {rows.filter(([, ids]) => ids !== null).map(([label, ids]) => (
            <li key={label}><button type="button" onClick={() => start(label, ids!)} disabled={!ids!.length}>{label}<span>{ids!.length}</span></button></li>
          ))}
        </ul>
      )}
      <h3>Lookahead{data.laField ? `: ${data.laField}` : ''}</h3>
      {data.laField ? (
        <ul className="jb-health">
          {(Object.keys(LOOKAHEAD_LABELS) as LookaheadBucket[]).map((b) => (
            <li key={b}><button type="button" onClick={() => start(LOOKAHEAD_LABELS[b], data.buckets.get(b) ?? [])} disabled={!(data.buckets.get(b) ?? []).length}>{LOOKAHEAD_LABELS[b]}<span>{(data.buckets.get(b) ?? []).length}</span></button></li>
          ))}
        </ul>
      ) : <p className="jb-quiet">Choose a date field for lookahead in Fields.</p>}
    </section>
  );
}

export function FieldsPanel() {
  const { store } = useBoard();
  const fields = useStoreSelect((s) => s.view.fields);
  const settings = useStoreSelect((s) => s.view.settings);
  const sorted = [...fields.values()].sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1));
  const last = sorted.length ? sorted[sorted.length - 1].sortKey : null;
  const edit = (ops: Op[]) => store.edit(ops);
  const add = (preset: string | null, kind: FieldRec['kind'] = 'text') => {
    const base = preset ? FIELD_PRESETS[preset] : { kind, label: 'New field', options: kind === 'picker' ? [{ id: newLocalId().slice(0, 12), label: 'Option', colour: 'gray' }] : [], showOnCard: false, presetKey: null, extra: {} };
    edit([{ type: 'field', op: 'create', id: newLocalId().slice(0, 24), value: { ...base, sortKey: keyBetween(last, null) } }]);
  };
  const usage = (fid: string) => [...store.view.nodes.values()].filter((n) => readDesignCard(n.data).fieldValues[fid] !== undefined).length;
  const la = (settings.lookahead ?? {}) as { fieldId?: string; horizonWeeks?: number };
  const h = readThresholds(settings);
  const [presetChoice, setPresetChoice] = useState('');
  return (
    <section className="jb-side" aria-label="Fields and board settings">
      <h2>Fields</h2>
      <ul className="jb-fields">
        {sorted.map((f, i) => (
          <li key={f.id}>
            <input aria-label={`Name of field ${f.label}`} value={f.label} maxLength={80} onChange={(e) => e.target.value && store.edit([{ type: 'field', op: 'patch', id: f.id, set: { label: e.target.value } }], { key: `field:${f.id}:label` })} />
            <span className="jb-quiet">{f.kind}</span>
            <label className="jb-check"><input type="checkbox" checked={f.showOnCard} onChange={(e) => edit([{ type: 'field', op: 'patch', id: f.id, set: { showOnCard: e.target.checked } }])} /> On card</label>
            <button type="button" disabled={i === 0} aria-label={`Move ${f.label} up`} onClick={() => edit([{ type: 'field', op: 'patch', id: f.id, set: { sortKey: keyBetween(sorted[i - 2]?.sortKey ?? null, sorted[i - 1].sortKey) } }])}>Up</button>
            {f.presetKey !== 'status' && <button type="button" className="jb-danger" onClick={() => {
              const n = usage(f.id);
              if (window.confirm(`Delete "${f.label}"? ${n} ${n === 1 ? 'card holds' : 'cards hold'} a value.`)) edit([{ type: 'field', op: 'delete', id: f.id }]);
            }}>Delete</button>}
            {f.kind === 'picker' && <Options field={f} />}
          </li>
        ))}
      </ul>
      <div className="jb-actions">
        <button type="button" onClick={() => add(null, 'picker')}>Add picker</button>
        <button type="button" onClick={() => add(null, 'text')}>Add text</button>
        <button type="button" onClick={() => add(null, 'toggle')}>Add toggle</button>
        <button type="button" onClick={() => add(null, 'date')}>Add date</button>
        <label className="jb-field"><span className="jb-row-label">Preset</span>
          <select value={presetChoice} onChange={(e) => { if (e.target.value) add(e.target.value); setPresetChoice(''); }}>
            <option value="">Choose a preset</option>
            {Object.entries(FIELD_PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
          </select>
        </label>
      </div>
      <h2>Board settings</h2>
      <label className="jb-check"><input type="checkbox" checked={settings.showChangeSummary === true} onChange={(e) => edit([{ type: 'board', op: 'patch', settings: { showChangeSummary: e.target.checked } }])} /> Show change summary</label>
      <label className="jb-field"><span className="jb-row-label">Lookahead date field</span>
        <select value={la.fieldId ?? ''} onChange={(e) => edit([{ type: 'board', op: 'patch', settings: { lookahead: { ...la, fieldId: e.target.value || undefined, horizonWeeks: la.horizonWeeks ?? 4 } } }])}>
          <option value="">None</option>
          {sorted.filter((f) => f.kind === 'date').map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select></label>
      <label className="jb-field"><span className="jb-row-label">Horizon (weeks)</span>
        <input type="number" min={1} max={52} value={la.horizonWeeks ?? 4} onChange={(e) => edit([{ type: 'board', op: 'patch', settings: { lookahead: { ...la, horizonWeeks: Math.max(1, Number(e.target.value)) } } }])} /></label>
      <label className="jb-field"><span className="jb-row-label">Aging after (days)</span>
        <input type="number" min={1} value={h.agingDays} onChange={(e) => edit([{ type: 'board', op: 'patch', settings: { health: { ...h, agingDays: Math.max(1, Number(e.target.value)) } } }])} /></label>
      <label className="jb-field"><span className="jb-row-label">Stale after (days)</span>
        <input type="number" min={1} value={h.staleDays} onChange={(e) => edit([{ type: 'board', op: 'patch', settings: { health: { ...h, staleDays: Math.max(1, Number(e.target.value)) } } }])} /></label>
    </section>
  );
}

/** JB-902: deleting an option in use needs a replacement first; both are one batch and one undo step. */
function Options({ field }: { field: FieldRec }) {
  const { store } = useBoard();
  const setOptions = (options: FieldRec['options'], extra: Op[] = []) => store.edit([...extra, { type: 'field', op: 'patch', id: field.id, set: { options } }]);
  return (
    <ul className="jb-options">
      {field.options.map((o, i) => (
        <li key={o.id}>
          <span className="jb-dot" style={{ background: colourOf(o.colour) }} />
          <input aria-label={`Option ${o.label}`} value={o.label} maxLength={80} onChange={(e) => e.target.value && store.edit([{ type: 'field', op: 'patch', id: field.id, set: { options: field.options.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) } }], { key: `field:${field.id}:options:${o.id}` })} />
          <select aria-label={`Colour of ${o.label}`} value={o.colour} onChange={(e) => setOptions(field.options.map((x, k) => (k === i ? { ...x, colour: e.target.value } : x)))}>
            {FIELD_COLOURS.map((c) => <option key={c}>{c}</option>)}
          </select>
          <button type="button" aria-label={`Delete option ${o.label}`} onClick={() => {
            const inUse = [...store.view.nodes.values()].filter((n) => readDesignCard(n.data).fieldValues[field.id] === o.id);
            const rest = field.options.filter((x) => x.id !== o.id);
            if (!inUse.length) { setOptions(rest); return; }
            const choice = window.prompt(`${inUse.length} cards use "${o.label}". Type the name of the replacement option: ${rest.map((r) => r.label).join(', ')}`);
            const repl = rest.find((r) => r.label === choice);
            if (!repl) return;
            setOptions(rest, inUse.map((n) => ({ type: 'node', op: 'patch', id: n.id, data: { [`fieldValues.${field.id}`]: repl.id } }) as Op));
          }}>Remove</button>
        </li>
      ))}
      <li><button type="button" onClick={() => setOptions([...field.options, { id: newLocalId().slice(0, 12), label: 'New option', colour: 'gray' }])}>Add option</button></li>
    </ul>
  );
}
