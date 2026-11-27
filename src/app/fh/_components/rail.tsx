'use client';

// Left rail (FH-004–006, D-38): Features tree and Journeys, each in its own scroll area; rows keep their height.
// Collapsible to a 40 px strip that still shows the active filter with a clear button (FH-005).
import { useMemo, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiFailure } from '../_lib/api';
import { keys, type Feature, type Lookups } from '../_lib/data';
import { btn, btnPrimary, Dialog, input } from './ui';
import MappedOnBoards from './mapped-on-boards';

export interface RailState { featureId: string | null; includeSub: boolean; journeyId: string | null }

const COLLAPSE_KEY = 'pet.fh.rail.collapsed.v1';
const collapseListeners = new Set<() => void>();
let collapseMemory = false; // used when storage is blocked
function readCollapse() { try { return window.localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return collapseMemory; } }
function writeCollapse(v: boolean) {
  collapseMemory = v;
  try { window.localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); } catch { /* memory only */ }
  collapseListeners.forEach((l) => l());
}
function subscribeCollapse(l: () => void) { collapseListeners.add(l); return () => { collapseListeners.delete(l); }; }

/** Feature tree in display order with each node's total including sub-features (FH-601). */
export function featureTree(features: Feature[]) {
  const children = new Map<string | null, Feature[]>();
  for (const f of features) children.set(f.parentId, [...(children.get(f.parentId) ?? []), f]);
  for (const list of children.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const out: { f: Feature; total: number }[] = [];
  const totals = new Map<string, number>();
  const sum = (f: Feature): number => {
    const t = f.allCount + (children.get(f.id) ?? []).reduce((n, c) => n + sum(c), 0);
    totals.set(f.id, t);
    return t;
  };
  (children.get(null) ?? []).forEach(sum);
  const walk = (parent: string | null) => (children.get(parent) ?? []).forEach((f) => { out.push({ f, total: totals.get(f.id) ?? f.allCount }); walk(f.id); });
  walk(null);
  return { rows: out, children };
}

export default function Rail({ lookups, state, onChange, isAdmin }: {
  lookups?: Lookups; state: RailState; onChange: (s: RailState) => void; isAdmin: boolean;
}) {
  const [editing, setEditing] = useState<{ mode: 'create' | 'edit'; parentId: string | null; feature?: Feature } | null>(null);
  const [msg, setMsg] = useState('');
  const qc = useQueryClient();
  // FH-005: remembered per browser. Read through an external-store subscription so server and first paint agree.
  const collapsed = useSyncExternalStore(subscribeCollapse, readCollapse, () => false);
  const toggle = () => writeCollapse(!collapsed);
  const tree = useMemo(() => featureTree(lookups?.features ?? []), [lookups?.features]);
  const activeFeature = lookups?.features.find((f) => f.id === state.featureId);
  const activeJourney = lookups?.journeys.find((j) => j.id === state.journeyId);

  const refresh = () => qc.invalidateQueries({ queryKey: keys.lookups });
  async function move(f: Feature, delta: number) {
    const sibs = (tree.children.get(f.parentId) ?? []);
    const idx = sibs.findIndex((s) => s.id === f.id);
    const pos = idx + delta;
    if (pos < 0 || pos >= sibs.length) return;
    try { await api(`/api/fh/features/${f.id}`, { method: 'PATCH', body: { position: pos } }); refresh(); } catch (e) { setMsg((e as Error).message); }
  }
  async function remove(f: Feature) {
    const subtree = tree.rows.filter((r) => {
      let p: Feature | undefined = r.f;
      while (p) { if (p.id === f.id) return r.f.id !== f.id; p = lookups!.features.find((x) => x.id === p!.parentId); }
      return false;
    });
    const ideas = tree.rows.find((r) => r.f.id === f.id)?.total ?? 0;
    if (!window.confirm(`Delete "${f.name}"? ${subtree.length} sub-Features will be deleted and ${ideas} ideas will lose their Feature. Board links are kept and flagged.`)) return;
    try {
      await api(`/api/fh/features/${f.id}`, { method: 'DELETE' });
      if (state.featureId === f.id) onChange({ ...state, featureId: null });
      refresh();
    } catch (e) { setMsg((e as Error).message); }
  }
  async function removeJourney(id: string, name: string) {
    if (!window.confirm(`Delete the Journey "${name}"? Its idea memberships go; ideas stay. A later sync from the board recreates it.`)) return;
    try { await api(`/api/fh/journeys/${id}`, { method: 'DELETE' }); if (state.journeyId === id) onChange({ ...state, journeyId: null }); refresh(); }
    catch (e) { setMsg((e as Error).message); }
  }

  if (collapsed) {
    return (
      <aside aria-label="Features and Journeys" className="hidden w-10 shrink-0 flex-col items-center gap-2 border-r border-[var(--border)] py-2 md:flex">
        <button className="grid h-8 w-8 place-items-center rounded hover:bg-[var(--hover)]" onClick={toggle} aria-label="Expand Features and Journeys" aria-expanded={false}>»</button>
        {(activeFeature || activeJourney) && (
          <div className="flex flex-col items-center gap-1">
            <span className="max-h-48 overflow-hidden text-xs [writing-mode:vertical-rl]" title={(activeFeature ?? activeJourney)!.name}>{(activeFeature ?? activeJourney)!.name}</span>
            <button className="grid h-6 w-6 place-items-center rounded hover:bg-[var(--hover)]" aria-label="Clear the rail filter"
              onClick={() => onChange({ ...state, featureId: null, journeyId: null })}>×</button>
          </div>
        )}
      </aside>
    );
  }

  const rowCls = (active: boolean) => `flex h-8 shrink-0 items-center gap-1 rounded px-1 text-sm ${active ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'hover:bg-[var(--hover)]'}`;

  return (
    <aside aria-label="Features and Journeys" className="hidden w-64 shrink-0 flex-col border-r border-[var(--border)] md:flex">
      <div className="flex items-center justify-between px-2 py-1">
        <h2 className="text-sm font-semibold">Features</h2>
        <div className="flex gap-1">
          {isAdmin && <button className="grid h-7 w-7 place-items-center rounded hover:bg-[var(--hover)]" aria-label="Add a top-level Feature" onClick={() => setEditing({ mode: 'create', parentId: null })}>+</button>}
          <button className="grid h-7 w-7 place-items-center rounded hover:bg-[var(--hover)]" onClick={toggle} aria-label="Collapse Features and Journeys" aria-expanded>«</button>
        </div>
      </div>
      <label className="flex items-center gap-2 px-2 pb-1 text-xs">
        <input type="checkbox" checked={state.includeSub} onChange={(e) => onChange({ ...state, includeSub: e.target.checked })} /> Include sub-features
      </label>
      {msg && <p role="alert" className="px-2 text-xs text-[var(--danger)]">{msg}</p>}
      {/* D-38: each list scrolls in its own area; rows keep their full height (shrink-0, fixed h-8). */}
      <ul className="min-h-24 flex-1 basis-0 overflow-y-auto px-1" aria-label="Features">
        {!lookups && <li className="px-2 text-sm text-[var(--muted)]">Loading…</li>}
        {lookups && !tree.rows.length && <li className="px-2 text-sm text-[var(--muted)]">No Features yet.</li>}
        {tree.rows.map(({ f, total }) => {
          const active = state.featureId === f.id;
          return (
            <li key={f.id} className={rowCls(active)} style={{ paddingLeft: 4 + f.depth * 14 }}>
              <button className="min-w-0 flex-1 truncate text-left" title={f.name} aria-pressed={active}
                onClick={() => onChange({ ...state, featureId: active ? null : f.id, journeyId: state.journeyId })}>
                {f.name}
              </button>
              <span className="shrink-0 text-xs tabular-nums opacity-80" title={`${f.allCount} directly, ${total} including sub-features`}>{state.includeSub ? total : f.allCount}</span>
              {isAdmin && (
                <details className="relative shrink-0">
                  <summary className="grid h-6 w-6 cursor-pointer list-none place-items-center rounded hover:bg-[var(--hover)]" aria-label={`Actions for ${f.name}`}>⋯</summary>
                  <div className="absolute right-0 z-20 mt-1 flex w-44 flex-col rounded-md border border-[var(--border)] bg-[var(--bg)] p-1 text-[var(--fg)] shadow-lg">
                    {f.depth < 2 && <button className="rounded px-2 py-1 text-left hover:bg-[var(--hover)]" onClick={() => setEditing({ mode: 'create', parentId: f.id })}>Add sub-Feature</button>}
                    <button className="rounded px-2 py-1 text-left hover:bg-[var(--hover)]" onClick={() => setEditing({ mode: 'edit', parentId: f.parentId, feature: f })}>Rename, describe or move</button>
                    <button className="rounded px-2 py-1 text-left hover:bg-[var(--hover)]" onClick={() => move(f, -1)}>Move up</button>
                    <button className="rounded px-2 py-1 text-left hover:bg-[var(--hover)]" onClick={() => move(f, 1)}>Move down</button>
                    <button className="rounded px-2 py-1 text-left text-[var(--danger)] hover:bg-[var(--hover)]" onClick={() => remove(f)}>Delete…</button>
                  </div>
                </details>
              )}
            </li>
          );
        })}
      </ul>
      <h2 className="border-t border-[var(--border)] px-2 pb-1 pt-2 text-sm font-semibold">Journeys</h2>
      <ul className="min-h-24 flex-1 basis-0 overflow-y-auto px-1 pb-2" aria-label="Journeys">
        {lookups && !lookups.journeys.length && <li className="px-2 text-sm text-[var(--muted)]">Journeys appear when a board syncs them.</li>}
        {lookups?.journeys.map((j) => {
          const active = state.journeyId === j.id;
          const synced = j.syncedAt ? `Last synced ${new Date(j.syncedAt).toLocaleString('en-GB')}` : 'Not synced yet';
          return (
            <li key={j.id} className={rowCls(active)}>
              <button className="min-w-0 flex-1 truncate text-left" title={`${j.name}. ${synced}`} aria-pressed={active}
                onClick={() => onChange({ ...state, journeyId: active ? null : j.id })}>{j.name}</button>
              <span className="shrink-0 text-xs tabular-nums opacity-80">{j.ideaCount}</span>
              {isAdmin && <button className="grid h-6 w-6 shrink-0 place-items-center rounded hover:bg-[var(--hover)]" aria-label={`Delete Journey ${j.name}`} onClick={() => removeJourney(j.id, j.name)}>×</button>}
            </li>
          );
        })}
      </ul>
      {(state.featureId || state.journeyId) && (
        <section aria-label="Mapped on boards" className="border-t border-[var(--border)] px-2 py-2">
          <h2 className="pb-1 text-sm font-semibold">Mapped on boards</h2>
          {state.featureId ? <MappedOnBoards kind="feature" id={state.featureId} /> : <MappedOnBoards kind="journey" id={state.journeyId} />}
        </section>
      )}
      {editing && lookups && (
        <FeatureDialog features={lookups.features} editing={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />
      )}
    </aside>
  );
}

function FeatureDialog({ features, editing, onClose, onSaved }: {
  features: Feature[]; editing: { mode: 'create' | 'edit'; parentId: string | null; feature?: Feature }; onClose: () => void; onSaved: () => void;
}) {
  const f = editing.feature;
  const [name, setName] = useState(f?.name ?? '');
  const [description, setDescription] = useState(f?.description ?? '');
  const [parentId, setParentId] = useState<string>(editing.parentId ?? '');
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null);
  const parents = features.filter((p) => p.depth < 2 && p.id !== f?.id);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (editing.mode === 'create') {
        await api('/api/fh/features', { method: 'POST', body: { name, description: description || null, parentId: editing.parentId } });
      } else {
        await api(`/api/fh/features/${f!.id}`, { method: 'PATCH', body: { name, description: description || null, ...(parentId !== (f!.parentId ?? '') && { parentId: parentId || null }) } });
      }
      onSaved();
    } catch (x) {
      setErr({ field: x instanceof ApiFailure ? String(x.details?.field ?? '') : undefined, message: (x as Error).message });
    }
  }
  return (
    <Dialog title={editing.mode === 'create' ? 'New Feature' : `Edit ${f!.name}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <label className="block text-sm">Name
          <input className={`${input} mt-1 w-full`} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required aria-describedby={err?.field === 'name' ? 'fe-err' : undefined} />
        </label>
        <label className="block text-sm">Description
          <textarea className={`${input} mt-1 w-full`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={3} />
        </label>
        {editing.mode === 'edit' && (
          <label className="block text-sm">Parent
            <select className={`${input} mt-1 w-full`} value={parentId} onChange={(e) => setParentId(e.target.value)} aria-describedby={err?.field === 'parentId' ? 'fe-err' : undefined}>
              <option value="">None (top level)</option>
              {parents.map((p) => <option key={p.id} value={p.id}>{'  '.repeat(p.depth)}{p.name}</option>)}
            </select>
          </label>
        )}
        {err && <p id="fe-err" role="alert" className="text-sm text-[var(--danger)]">{err.message}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="submit" className={btnPrimary}>Save</button>
        </div>
      </form>
    </Dialog>
  );
}
