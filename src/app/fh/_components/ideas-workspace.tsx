'use client';

// The Ideas section (FH-001–003, FH-101–112): view tabs, rail, table / roadmap / board, panel, live updates.
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { VIEWS, VIEW_LABEL, matchesView, type View } from '@/modules/fh/domain';
import { isUuid, type ViewSpecInput } from '@/modules/fh/columns';
import type { IdeaRow } from '@/modules/fh/rows';
import { api, specParam } from '../_lib/api';
import { insertCreated, keys, removeFromLists, useIdeasList, useLookups, type IdsPage } from '../_lib/data';
import { loadLayout, saveLayout, type Layout } from '../_lib/layout';
import { useLiveChannels, type LiveEvent } from '../_lib/live';
import { rowStore } from '../_lib/rows';
import { pruneSelection, selectionScope } from '../_lib/selection';
import Rail, { type RailState } from './rail';
import IdeasTable from './ideas-table';
import IdeaPanel from './idea-panel';
import CreateIdeaDialog from './create-idea';
import Roadmap from './roadmap';
import Board from './board';
import SavedViews from './saved-views';
import TriageBar from './triage-bar';
import { btn, btnPrimary, input } from './ui';
import type { InfiniteData } from '@tanstack/react-query';

const viewFromPath = (p: string): View => {
  const seg = p.split('/')[3];
  return (VIEWS as readonly string[]).includes(seg) ? (seg as View) : 'all';
};
function readDeepLink(): { idea: string | null; feature: string | null; journey: string | null; view: string | null } {
  if (typeof window === 'undefined') return { idea: null, feature: null, journey: null, view: null };
  const sp = new URLSearchParams(window.location.search);
  const id = (k: string) => { const v = sp.get(k); return isUuid(v) ? v : null; };
  return { idea: id('idea'), feature: id('feature'), journey: id('journey'), view: id('view') };
}
const pathFor = (v: View) => (v === 'all' ? '/fh/ideas' : `/fh/ideas/${v}`);

export type Filters = Record<string, (string | null)[]>;

export default function IdeasWorkspace() {
  const pathname = usePathname();
  const router = useRouter();
  const view = viewFromPath(pathname);
  const qc = useQueryClient();
  const lookups = useLookups();
  const userId = lookups.data?.access.userId ?? '';
  const isAdmin = lookups.data?.access.feedbackAdmin ?? false;

  const [deepLink] = useState(readDeepLink);
  const [rail, setRail] = useState<RailState>(() => ({
    featureId: deepLink.feature, includeSub: !!deepLink.feature, journeyId: deepLink.journey,
  }));
  const [filters, setFilters] = useState<Filters>({});
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [layouts, setLayouts] = useState<Partial<Record<View, Layout>>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(deepLink.idea);
  const [creating, setCreating] = useState(false);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const [savedViewId, setSavedViewId] = useState<string | null>(deepLink.view);

  // FH-103: search is debounced 250 ms and applied on the server.
  useEffect(() => { const t = setTimeout(() => setSearch(searchText), 250); return () => clearTimeout(t); }, [searchText]);

  const layout = useMemo(() => layouts[view] ?? (userId ? loadLayout(userId, view) : null), [layouts, view, userId]);
  const updateLayout = useCallback((l: Layout) => {
    setLayouts((x) => ({ ...x, [view]: l }));
    if (userId) saveLayout(userId, view, l);
  }, [userId, view]);

  // Rail ids that no longer exist (or came from a bad link) are ignored, not treated as "match nothing".
  const railFeature = rail.featureId && (!lookups.data || lookups.data.features.some((f) => f.id === rail.featureId)) ? rail.featureId : null;
  const railJourney = rail.journeyId && (!lookups.data || lookups.data.journeys.some((j) => j.id === rail.journeyId)) ? rail.journeyId : null;
  const spec: ViewSpecInput = useMemo(() => ({
    view, rail: { featureId: railFeature, includeSub: rail.includeSub, journeyId: railJourney },
    filters, search, sort: layout?.sort ?? null,
  }), [view, railFeature, railJourney, rail.includeSub, filters, search, layout?.sort]);

  const tableView = view === 'all' || view === 'triage' || view === 'backlog';
  const list = useIdeasList(spec, tableView && !!layout);
  const loadedIds = useMemo(() => list.data?.pages.flatMap((p) => p.ids) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total ?? 0;

  // FH-152 / D-32: selection clears when the view, search, rail or section changes, and is pruned to what is visible.
  const scope = selectionScope({ view, search, rail });
  const scopeRef = useRef(scope);
  useEffect(() => {
    if (scopeRef.current !== scope) { scopeRef.current = scope; setSelected(new Set()); setNewIds(new Set()); }
  }, [scope]);
  const allMatching = useRef(false);
  useEffect(() => {
    if (!list.data || allMatching.current) return;
    setSelected((s) => (s.size ? pruneSelection(s, loadedIds) : s));
  }, [loadedIds, list.data]);
  const selectAllMatching = useCallback(async () => {
    const r = await api<{ ids: string[]; total: number }>('/api/fh/ideas/ids', { method: 'POST', body: { viewSpec: spec } });
    allMatching.current = true;
    setSelected(new Set(r.ids));
    if (r.total > r.ids.length) setNotice(`Selected the first ${r.ids.length.toLocaleString('en-GB')} of ${r.total.toLocaleString('en-GB')} matching ideas.`);
  }, [spec]);
  const setSelectedFromTable = useCallback((s: Set<string>) => { allMatching.current = false; setSelected(s); }, []);
  useEffect(() => { allMatching.current = false; }, [filters]);

  // FH-003: deep-link parameters are read once on load, then removed from the address bar. A ?feature= link covers the
  // Feature and its descendants (shown in the rail with "include sub-features"); unknown ids are ignored below.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (!sp.has('idea') && !sp.has('feature') && !sp.has('journey')) return;
    sp.delete('idea'); sp.delete('feature'); sp.delete('journey');
    const q = sp.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${q ? `?${q}` : ''}`);
  }, []);

  // Live updates (FH-112, PERF-B17). Without realtime, poll the first page every 30 s (ARC-25).
  const onEvent = useCallback((e: LiveEvent) => {
    if (e.event === 'idea.upserted') {
      const row = e.payload.row;
      const known = !!rowStore.get(row.id);
      rowStore.upsert([row]);
      if (!known && matchesView(view, row)) setNewIds((s) => new Set(s).add(row.id));
      qc.invalidateQueries({ queryKey: ['fh', 'idea', 'summary', row.id] });
    } else if (e.event === 'idea.removed') {
      removeFromLists(qc, [e.payload.id]);
      if (openId === e.payload.id && e.payload.mergedIntoId) setOpenId(e.payload.mergedIntoId);
    } else if (e.event === 'lookup.changed') {
      qc.invalidateQueries({ queryKey: keys.lookups });
    }
  }, [qc, view, openId]);
  const live = useLiveChannels(['fh.workspace'], onEvent);
  useEffect(() => {
    if (live || !tableView) return;
    const t = setInterval(async () => {
      try {
        const r = await api<{ rows: IdeaRow[] }>(`/api/fh/ideas?${specParam(spec)}`);
        const loaded = new Set(loadedIds);
        rowStore.upsert(r.rows);
        const fresh = r.rows.filter((x) => !loaded.has(x.id)).map((x) => x.id);
        if (fresh.length) setNewIds((s) => new Set([...s, ...fresh]));
        qc.invalidateQueries({ queryKey: keys.lookups });
      } catch { /* next tick */ }
    }, 30_000);
    return () => clearInterval(t);
  }, [live, tableView, spec, loadedIds, qc]);

  const showNew = () => { setNewIds(new Set()); qc.resetQueries({ queryKey: keys.ideas(spec) }); };

  const onCreated = (row: IdeaRow) => {
    insertCreated(qc, spec, row); // D-01: no list or lookup refetch
    setCreating(false);
    setOpenId(row.id); // D-02: panel paints from the create response in the same render
    if (row.featureId) {
      qc.setQueryData(keys.lookups, (d: typeof lookups.data) => d && {
        ...d, features: d.features.map((f) => f.id === row.featureId ? { ...f, allCount: f.allCount + 1, openCount: f.openCount + 1 } : f),
      });
    }
  };

  const onDeleted = (ids: string[]) => {
    removeFromLists(qc, ids);
    setSelected((s) => pruneSelection(s, loadedIds.filter((x) => !ids.includes(x))));
    if (openId && ids.includes(openId)) setOpenId(null);
  };

  const applySaved = (cfg: { view: View; rail?: Partial<RailState>; filters?: Filters; search?: string; sort?: Layout['sort']; columns?: string[]; widths?: Record<string, number> }, id: string) => {
    const lf = lookups.data;
    let lost = false;
    const railNext: RailState = { featureId: null, includeSub: !!cfg.rail?.includeSub, journeyId: null };
    if (cfg.rail?.featureId) { if (lf?.features.some((f) => f.id === cfg.rail!.featureId)) railNext.featureId = cfg.rail.featureId; else lost = true; }
    if (cfg.rail?.journeyId) { if (lf?.journeys.some((j) => j.id === cfg.rail!.journeyId)) railNext.journeyId = cfg.rail.journeyId; else lost = true; }
    setRail(railNext);
    setFilters(cfg.filters ?? {});
    setSearchText(cfg.search ?? ''); setSearch(cfg.search ?? '');
    if (userId && (cfg.columns || cfg.sort !== undefined || cfg.widths)) {
      const base = loadLayout(userId, cfg.view);
      const next: Layout = {
        ...base, sort: cfg.sort ?? null, widths: { ...base.widths, ...(cfg.widths ?? {}) },
        ...(cfg.columns && { hidden: base.order.filter((c) => !cfg.columns!.includes(c) && c !== 'title') }),
      };
      setLayouts((x) => ({ ...x, [cfg.view]: next }));
      saveLayout(userId, cfg.view, next);
    }
    setSavedViewId(id);
    // FH-904: parts that no longer exist are ignored, with a notice.
    setNotice(lost ? 'Some filters in this view no longer apply.' : '');
    router.push(`${pathFor(cfg.view)}?view=${id}`);
  };

  const currentConfig = () => ({
    version: 1 as const, view, rail, filters, search, sort: layout?.sort ?? null,
    columns: layout ? layout.order.filter((c) => !layout.hidden.includes(c)) : undefined,
    widths: layout?.widths,
  });

  const filterCount = Object.values(filters).filter((v) => v.length).length;
  const navIds = loadedIds;

  return (
    <main className="flex h-[calc(100dvh-49px)] flex-col md:h-dvh">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <h1 className="sr-only">Ideas</h1>
        <nav aria-label="Idea views" className="flex flex-wrap gap-1">
          {VIEWS.map((v) => (
            <Link key={v} href={pathFor(v)} aria-current={v === view ? 'page' : undefined}
              className={`rounded-md px-3 py-1 text-sm font-medium ${v === view ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'hover:bg-[var(--hover)]'}`}>
              {VIEW_LABEL[v]}
            </Link>
          ))}
        </nav>
        <SavedViews activeId={savedViewId} isAdmin={isAdmin} onApply={applySaved} currentConfig={currentConfig} />
        <label className="ml-auto flex items-center gap-1 text-sm">
          <span className="sr-only">Search titles</span>
          <input type="search" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search titles" className={`${input} w-40 sm:w-56`} />
        </label>
        {filterCount > 0 && <button className={btn} onClick={() => setFilters({})}>Clear filters ({filterCount})</button>}
        <button className={btnPrimary} onClick={() => setCreating(true)}>New idea</button>
      </div>
      <div role="status" aria-live="polite" className="text-sm">
        {!live && <p className="border-b border-[var(--border)] bg-[var(--panel)] px-3 py-1 text-[var(--muted)]">Live updates paused. Checking for changes every 30 seconds.</p>}
        {notice && <p className="border-b border-[var(--border)] px-3 py-1">{notice} <button className="underline" onClick={() => setNotice('')}>Dismiss</button></p>}
      </div>
      <div className="flex min-h-0 flex-1">
        <Rail lookups={lookups.data} state={rail} onChange={setRail} isAdmin={isAdmin} />
        <div className="flex min-w-0 flex-1 flex-col">
          {view === 'triage' && <TriageBar spec={spec} filters={filters} onFilters={setFilters} isAdmin={isAdmin} onMessage={setNotice} />}
          {tableView && layout && (
            <IdeasTable
              view={view} spec={spec} lookups={lookups.data} layout={layout} onLayout={updateLayout}
              ids={loadedIds} total={total} list={list} filters={filters} onFilters={setFilters}
              selected={selected} onSelected={setSelectedFromTable} onSelectAllMatching={selectAllMatching}
              isAdmin={isAdmin} openId={openId} onOpen={setOpenId} newCount={newIds.size} onShowNew={showNew}
              onDeleted={onDeleted}
            />
          )}
          {view === 'roadmap' && lookups.data && <Roadmap spec={spec} lookups={lookups.data} isAdmin={isAdmin} onOpen={setOpenId} filterCount={filterCount} onClearFilters={() => setFilters({})} />}
          {view === 'board' && lookups.data && <Board spec={spec} lookups={lookups.data} isAdmin={isAdmin} onOpen={setOpenId} />}
        </div>
        {openId && lookups.data && (
          <IdeaPanel
            key={openId} id={openId} lookups={lookups.data} isAdmin={isAdmin} view={view}
            onClose={() => setOpenId(null)} onOpen={setOpenId} onDeleted={onDeleted}
            onNavigate={(dir) => {
              const i = navIds.indexOf(openId);
              const next = navIds[i + dir];
              if (next) setOpenId(next);
            }}
          />
        )}
      </div>
      {creating && lookups.data && (
        <CreateIdeaDialog lookups={lookups.data} defaultFeatureId={rail.featureId} onClose={() => setCreating(false)} onCreated={onCreated} />
      )}
    </main>
  );
}

export type ListQuery = ReturnType<typeof useIdeasList>;
export type { InfiniteData, IdsPage };
