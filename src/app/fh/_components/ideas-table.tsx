'use client';

// Virtualised, server-paginated ideas grid (PERF-11, NFR-03, D-06, D-08). At most the visible rows plus overscan
// are in the DOM; rows subscribe to their own cached entry; one shared editor mounts only on the active cell.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { COLUMN_BY_ID, COLUMNS, MIN_COLUMN_WIDTH, type ViewSpecInput } from '@/modules/fh/columns';
import { statusKeyOf, type View } from '@/modules/fh/domain';
import type { Lookups } from '../_lib/data';
import { downloadExport } from '../_lib/api';
import { reloadRow, saveField } from '../_lib/edit';
import { nextSort, widthOf, type Layout } from '../_lib/layout';
import { rowStore, useRow } from '../_lib/rows';
import { fmtCount } from '../_lib/selection';
import type { ListQuery, Filters } from './ideas-workspace';
import { Cell } from './cells';
import CellEditor from './cell-editor';
import FilterMenu from './filter-menu';
import BulkBar from './bulk-bar';
import { btn } from './ui';

export const ROW_HEIGHT = 36;
export const OVERSCAN = 12;

interface Props {
  view: View; spec: ViewSpecInput; lookups?: Lookups; layout: Layout; onLayout: (l: Layout) => void;
  ids: string[]; total: number; list: ListQuery; filters: Filters; onFilters: (f: Filters) => void;
  selected: Set<string>; onSelected: (s: Set<string>) => void; onSelectAllMatching: () => Promise<void>;
  isAdmin: boolean; openId: string | null; onOpen: (id: string) => void; newCount: number; onShowNew: () => void;
  onDeleted: (ids: string[]) => void;
}

export default function IdeasTable(p: Props) {
  const { layout, ids, isAdmin, lookups } = p;
  const cols = useMemo(() => layout.order.filter((c) => !layout.hidden.includes(c) && COLUMN_BY_ID[c]), [layout]);
  const widths = useMemo(() => cols.map((c) => widthOf(layout, c)), [cols, layout]);
  const totalWidth = 44 + widths.reduce((a, b) => a + b, 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: ids.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_HEIGHT, overscan: OVERSCAN });
  const items = v.getVirtualItems();

  // Scrolling near the end of loaded rows fetches the next page in the background (PERF-11).
  const lastIndex = items[items.length - 1]?.index ?? 0;
  useEffect(() => {
    if (lastIndex >= ids.length - 20 && p.list.hasNextPage && !p.list.isFetchingNextPage) void p.list.fetchNextPage();
  }, [lastIndex, ids.length, p.list]);

  // Keyboard grid navigation (NFR-03): column 0 is the selection checkbox.
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<{ text: string; rowId?: string } | null>(null);
  const [filterCol, setFilterCol] = useState<{ col: string; x: number; y: number } | null>(null);
  const [showColumns, setShowColumns] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const focusActive = useCallback(() => {
    if (!active) return;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-cell="${active.r}:${active.c}"]`);
    el?.focus({ preventScroll: false });
  }, [active]);
  useLayoutEffect(() => { if (active && !editing) { if (active.r >= 0) v.scrollToIndex(active.r); requestAnimationFrame(focusActive); } }, [active, editing, focusActive, v]);

  const colAt = (c: number) => (c === 0 ? '__select' : cols[c - 1]);
  const editableKind = (col: string) => (isAdmin ? COLUMN_BY_ID[col]?.edit : undefined);

  async function commit(rowId: string, col: string, value: Parameters<typeof saveField>[2]) {
    setEditing(false);
    const res = await saveField(rowId, col, value);
    if (!res.ok) setMessage({ text: res.conflict ? 'This idea changed since you loaded it.' : res.message ?? 'Could not save.', rowId: res.conflict ? rowId : undefined });
    else setMessage(null);
    requestAnimationFrame(focusActive);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (editing || !active || !ids.length) return;
    const maxC = cols.length;
    const move = (r: number, c: number) => { e.preventDefault(); setActive({ r: Math.max(-1, Math.min(ids.length - 1, r)), c: Math.max(0, Math.min(maxC, c)) }); };
    switch (e.key) {
      case 'ArrowDown': return move(active.r + 1, active.c);
      case 'ArrowUp': return move(active.r - 1, active.c);
      case 'ArrowRight': return move(active.r, active.c + 1);
      case 'ArrowLeft': return move(active.r, active.c - 1);
      case 'Home': return move(active.r, 0);
      case 'End': return move(active.r, maxC);
      case 'PageDown': return move(active.r + 15, active.c);
      case 'PageUp': return move(active.r - 15, active.c);
    }
    if (active.r < 0) return;
    const rowId = ids[active.r];
    const col = colAt(active.c);
    if ((e.key === ' ' && col === '__select')) { e.preventDefault(); toggle(rowId); return; }
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      const kind = editableKind(col);
      const row = rowStore.get(rowId);
      if (kind === 'bool' && row) {
        if (col === 'committed' && ['IDEA_OPEN', 'BUG_OPEN'].includes(statusKeyOf(row) ?? '')) { setMessage({ text: 'An idea in Open cannot be committed. Triage it first.' }); return; }
        void commit(rowId, col, col === 'committed' ? !row.isCommitted : !row.isDealbreaker);
      } else if (kind) setEditing(true);
      else p.onOpen(rowId);
    }
  }

  const toggle = (id: string) => {
    const s = new Set(p.selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    p.onSelected(s);
  };
  const allLoadedSelected = ids.length > 0 && ids.every((id) => p.selected.has(id));
  const moreThanLoaded = p.total > ids.length;

  const setWidth = (col: string, w: number) => p.onLayout({ ...layout, widths: { ...layout.widths, [col]: Math.max(MIN_COLUMN_WIDTH, Math.round(w)) } });

  function startResize(e: React.PointerEvent, col: string) {
    e.preventDefault(); e.stopPropagation();
    const start = e.clientX, w0 = widthOf(layout, col);
    const onMove = (ev: PointerEvent) => setWidth(col, w0 + ev.clientX - start);
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  }

  const visibleCount = cols.length, allCount = COLUMNS.length;
  const exportAll = async () => {
    setMessage({ text: 'Preparing export…' });
    try { const n = await downloadExport({ viewSpec: p.spec, columns: cols }); setMessage({ text: `Exported ${fmtCount(n)} ideas.` }); }
    catch (e) { setMessage({ text: (e as Error).message }); }
  };

  const activeRowId = active && active.r >= 0 ? ids[active.r] : null;
  const activeCol = active ? colAt(active.c) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-sm">
        <span className="font-medium" aria-live="polite">{p.list.isLoading ? 'Loading ideas…' : `${fmtCount(p.total)} ideas`}</span>
        <div className="relative">
          <button className={btn} aria-expanded={showColumns} onClick={() => setShowColumns((x) => !x)}>Columns ({visibleCount}/{allCount})</button>
          {showColumns && <ColumnsMenu layout={layout} onLayout={p.onLayout} onClose={() => setShowColumns(false)} />}
        </div>
        {p.view !== 'roadmap' && <button className={btn} onClick={exportAll} disabled={!p.total}>Export all filtered ({fmtCount(p.total)})</button>}
        {p.list.isError && <span role="alert" className="text-[var(--danger)]">Could not load ideas. <button className="underline" onClick={() => p.list.refetch()}>Try again</button></span>}
      </div>
      {message && (
        <div role="alert" className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-1 text-sm">
          <span>{message.text}</span>
          {message.rowId && <button className="underline" onClick={async () => { await reloadRow(message.rowId!); setMessage(null); }}>Reload</button>}
          <button className="ml-auto underline" onClick={() => setMessage(null)}>Dismiss</button>
        </div>
      )}
      {p.newCount > 0 && (
        <button className="border-b border-[var(--border)] bg-[var(--accent)] px-3 py-1 text-left text-sm font-medium text-[var(--accent-fg)]" onClick={p.onShowNew}>
          {fmtCount(p.newCount)} new {p.newCount === 1 ? 'idea' : 'ideas'}: show
        </button>
      )}
      {p.selected.size > 0 && (
        <BulkBar ids={[...p.selected]} spec={p.spec} columns={cols} lookups={lookups} isAdmin={isAdmin}
          onClear={() => p.onSelected(new Set())} onDeleted={p.onDeleted} onMessage={(t) => setMessage({ text: t })} />
      )}
      {allLoadedSelected && moreThanLoaded && p.selected.size < p.total && (
        <div className="border-b border-[var(--border)] px-3 py-1 text-sm">
          All {fmtCount(ids.length)} loaded ideas are selected. <button className="underline" onClick={() => void p.onSelectAllMatching()}>Select all {fmtCount(p.total)} matching ideas</button>
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" onScroll={() => setFilterCol(null)}>
        <div ref={gridRef} role="grid" aria-label="Ideas" aria-rowcount={p.total + 1} aria-colcount={cols.length + 1}
          aria-multiselectable="true" onKeyDown={onKeyDown} style={{ width: totalWidth, minWidth: '100%' }} className="relative text-sm">
          <div role="row" aria-rowindex={1} className="sticky top-0 z-10 flex border-b border-[var(--border)] bg-[var(--bg)] font-semibold">
            <div role="columnheader" className="flex w-11 shrink-0 items-center justify-center" data-cell="-1:0" tabIndex={!active || (active.r === -1 && active.c === 0) ? 0 : -1}
              onFocus={() => setActive({ r: -1, c: 0 })}>
              <input type="checkbox" aria-label="Select all loaded ideas" className="h-4 w-4" checked={allLoadedSelected}
                onChange={() => p.onSelected(allLoadedSelected ? new Set() : new Set(ids))} />
            </div>
            {cols.map((col, i) => {
              const def = COLUMN_BY_ID[col];
              const sorted = layout.sort?.column === col ? layout.sort.dir : null;
              const filtered = (p.filters[col]?.length ?? 0) > 0;
              return (
                <div key={col} role="columnheader" aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                  data-cell={`-1:${i + 1}`} tabIndex={active?.r === -1 && active.c === i + 1 ? 0 : -1} onFocus={() => setActive({ r: -1, c: i + 1 })}
                  onContextMenu={(e) => { if (def.filter) { e.preventDefault(); setFilterCol({ col, x: e.clientX, y: e.clientY }); } }}
                  className="relative flex shrink-0 items-center gap-1 px-2 py-2" style={{ width: widths[i] }}>
                  {def.sort ? (
                    <button className="min-w-0 truncate text-left hover:underline" title={`Sort by ${def.label}`}
                      onClick={() => p.onLayout({ ...layout, sort: nextSort(layout.sort, col) })}>
                      {def.label}{sorted === 'asc' ? ' ▲' : sorted === 'desc' ? ' ▼' : ''}
                    </button>
                  ) : <span className="min-w-0 truncate">{def.label}</span>}
                  {def.filter && (
                    <button aria-label={`Filter ${def.label}${filtered ? ' (filtered)' : ''}`} aria-haspopup="dialog"
                      className={`grid h-6 w-6 shrink-0 place-items-center rounded ${filtered ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'hover:bg-[var(--hover)]'}`}
                      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setFilterCol({ col, x: r.left, y: r.bottom }); }}>▾</button>
                  )}
                  <span role="separator" aria-orientation="vertical" aria-label={`Resize ${def.label}`} tabIndex={0}
                    aria-valuenow={widths[i]} aria-valuemin={MIN_COLUMN_WIDTH}
                    onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); setWidth(col, widths[i] + (e.key === 'ArrowRight' ? 16 : -16)); } }}
                    onPointerDown={(e) => startResize(e, col)}
                    className="absolute right-0 top-0 h-full w-2 cursor-col-resize hover:bg-[var(--accent)]" />
                </div>
              );
            })}
          </div>
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {!p.list.isLoading && !ids.length && <p className="p-4 text-[var(--muted)]">No ideas match this view.</p>}
            {items.map((it) => (
              <Row key={ids[it.index]} id={ids[it.index]} index={it.index} top={it.start} cols={cols} widths={widths}
                lookups={lookups} view={p.view} selected={p.selected.has(ids[it.index])} open={p.openId === ids[it.index]}
                activeCol={active?.r === it.index ? active.c : -1} onToggle={toggle} onOpen={p.onOpen}
                onActivate={(c) => setActive({ r: it.index, c })} />
            ))}
          </div>
          {p.list.isFetchingNextPage && <p className="p-2 text-xs text-[var(--muted)]">Loading more…</p>}
        </div>
      </div>
      {editing && activeRowId && activeCol && lookups && (
        <CellEditor rowId={activeRowId} col={activeCol} lookups={lookups} anchor={gridRef.current?.querySelector<HTMLElement>(`[data-cell="${active!.r}:${active!.c}"]`) ?? null}
          onCommit={(value) => commit(activeRowId, activeCol, value)} onCancel={() => { setEditing(false); requestAnimationFrame(focusActive); }}
          onMessage={(t) => setMessage({ text: t })} />
      )}
      {filterCol && (
        <FilterMenu col={filterCol.col} x={filterCol.x} y={filterCol.y} spec={p.spec} lookups={lookups}
          value={p.filters[filterCol.col] ?? []} onChange={(vals) => p.onFilters({ ...p.filters, [filterCol.col]: vals })} onClose={() => setFilterCol(null)} />
      )}
    </div>
  );
}

/** One row, memoised by id and its cached version (PERF-11). */
const Row = memo(function Row({ id, index, top, cols, widths, lookups, view, selected, open, activeCol, onToggle, onOpen, onActivate }: {
  id: string; index: number; top: number; cols: string[]; widths: number[]; lookups?: Lookups; view: View; selected: boolean; open: boolean;
  activeCol: number; onToggle: (id: string) => void; onOpen: (id: string) => void; onActivate: (c: number) => void;
}) {
  const row = useRow(id);
  if (!row) return null;
  return (
    <div role="row" aria-rowindex={index + 2} aria-selected={selected}
      className={`absolute left-0 flex w-full border-b border-[var(--border)] ${open ? 'bg-[var(--hover)]' : selected ? 'bg-[var(--panel)]' : ''}`}
      style={{ top, height: ROW_HEIGHT }}>
      <div role="gridcell" data-cell={`${index}:0`} tabIndex={activeCol === 0 ? 0 : -1} onFocus={() => onActivate(0)}
        className="flex w-11 shrink-0 items-center justify-center">
        <input type="checkbox" tabIndex={-1} className="h-4 w-4" aria-label={`Select #${row.number} ${row.title}`} checked={selected} onChange={() => onToggle(id)} />
      </div>
      {cols.map((col, i) => (
        <div key={col} role="gridcell" data-cell={`${index}:${i + 1}`} tabIndex={activeCol === i + 1 ? 0 : -1}
          onFocus={() => onActivate(i + 1)}
          onClick={col === 'title' ? () => onOpen(id) : undefined}
          className={`flex shrink-0 items-center overflow-hidden px-2 ${col === 'title' ? 'cursor-pointer' : ''}`} style={{ width: widths[i] }}>
          <Cell row={row} col={col} lookups={lookups} view={view} />
        </div>
      ))}
    </div>
  );
});

function ColumnsMenu({ layout, onLayout, onClose }: { layout: Layout; onLayout: (l: Layout) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const move = (i: number, d: number) => {
    const order = [...layout.order];
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    onLayout({ ...layout, order });
  };
  return (
    <div ref={ref} role="dialog" aria-label="Columns" className="absolute left-0 z-30 mt-1 max-h-96 w-72 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 shadow-lg">
      <ul className="space-y-0.5">
        {layout.order.map((col, i) => (
          <li key={col} className="flex items-center gap-1">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
              <input type="checkbox" disabled={col === 'title'} checked={!layout.hidden.includes(col)}
                onChange={(e) => onLayout({ ...layout, hidden: e.target.checked ? layout.hidden.filter((h) => h !== col) : [...layout.hidden, col] })} />
              <span className="truncate">{COLUMN_BY_ID[col].label}</span>
            </label>
            <button className="grid h-6 w-6 place-items-center rounded hover:bg-[var(--hover)]" aria-label={`Move ${COLUMN_BY_ID[col].label} left`} onClick={() => move(i, -1)}>↑</button>
            <button className="grid h-6 w-6 place-items-center rounded hover:bg-[var(--hover)]" aria-label={`Move ${COLUMN_BY_ID[col].label} right`} onClick={() => move(i, 1)}>↓</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
