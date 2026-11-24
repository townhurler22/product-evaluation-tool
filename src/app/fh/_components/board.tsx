'use client';

// Board (kanban) view (FH-771–774): the All view's ideas grouped by status, type, owner or Feature. Each column loads
// 50 cards and more on scroll, virtualised. Drag and drop only when grouped by status, with a "Move to status" menu
// as the non-drag alternative (NFR-02). A drop into the other workflow is refused.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { allowedTargets, IDEA_TYPES, sameWorkflow, statusKeyOf, statusLabel, STATUS_KEYS, TYPE_LABEL, type StatusKey } from '@/modules/fh/domain';
import type { ViewSpecInput } from '@/modules/fh/columns';
import type { IdeaRow } from '@/modules/fh/rows';
import { api, downloadExport, specParam } from '../_lib/api';
import { keys, type Lookups } from '../_lib/data';
import { saveField } from '../_lib/edit';
import { rowStore, useRow } from '../_lib/rows';
import { fmtCount } from '../_lib/selection';
import { btn, input, StatusPill } from './ui';

type Group = 'status' | 'type' | 'owner' | 'feature';
interface Column { key: string | null; total: number | null; ids: string[]; nextCursor: string | null }

export default function Board({ spec, lookups, isAdmin, onOpen }: { spec: ViewSpecInput; lookups: Lookups; isAdmin: boolean; onOpen: (id: string) => void }) {
  const [group, setGroup] = useState<Group>('status');
  const [msg, setMsg] = useState('');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: keys.board(spec, group), staleTime: 30_000,
    queryFn: async () => {
      const r = await api<{ columns: { key: string | null; total: number | null; rows: IdeaRow[]; nextCursor: string | null }[] }>(`/api/fh/board?${specParam(spec)}&group=${group}`);
      r.columns.forEach((c) => rowStore.upsert(c.rows));
      return r.columns.map((c) => ({ key: c.key, total: c.total, ids: c.rows.map((x) => x.id), nextCursor: c.nextCursor }));
    },
  });

  // FH-772: status and type show every value (bug columns labelled "Bug · <status>"); owner and Feature show values present plus "no value".
  const columns: Column[] = useMemo(() => {
    const got = new Map((q.data ?? []).map((c) => [c.key, c]));
    const fixed = group === 'status' ? STATUS_KEYS : group === 'type' ? [...IDEA_TYPES] : null;
    if (fixed) return fixed.map((k) => got.get(k) ?? { key: k, total: 0, ids: [], nextCursor: null });
    const present = [...got.values()].filter((c) => c.key !== null);
    return [...present, got.get(null) ?? { key: null, total: 0, ids: [], nextCursor: null }];
  }, [q.data, group]);

  const label = (key: string | null) => {
    if (group === 'status') return statusLabel(key as StatusKey, true);
    if (group === 'type') return TYPE_LABEL[key as keyof typeof TYPE_LABEL];
    if (group === 'owner') return key ? lookups.owners.find((o) => o.id === key)?.name ?? 'Former user' : 'Unassigned';
    return key ? lookups.features.find((f) => f.id === key)?.name ?? 'Deleted Feature' : 'No Feature';
  };

  async function move(id: string, to: StatusKey) {
    const row = rowStore.get(id);
    const from = row && statusKeyOf(row);
    if (!row || !from || from === to) return;
    if (!sameWorkflow(from, to)) { setMsg('Ideas and bugs use different workflows. Change the type instead.'); return; }
    const r = await saveField(id, 'status', to);
    if (!r.ok) { setMsg(r.message ?? 'Could not move the card.'); return; }
    setMsg('');
    qc.setQueryData<Column[]>(keys.board(spec, group), (cols) => cols?.map((c) => ({
      ...c,
      ids: c.key === to ? [id, ...c.ids.filter((x) => x !== id)] : c.ids.filter((x) => x !== id),
      total: c.total === null ? null : c.key === to ? c.total + 1 : c.key === from ? c.total - 1 : c.total,
    })));
  }

  async function loadMore(col: Column) {
    if (!col.nextCursor) return;
    const r = await api<{ columns: { rows: IdeaRow[]; nextCursor: string | null }[] }>(`/api/fh/board?${specParam(spec)}&group=${group}&column=${encodeURIComponent(col.key ?? '')}&cursor=${encodeURIComponent(col.nextCursor)}`);
    rowStore.upsert(r.columns[0].rows);
    qc.setQueryData<Column[]>(keys.board(spec, group), (cols) => cols?.map((c) => c.key === col.key ? { ...c, ids: [...c.ids, ...r.columns[0].rows.map((x) => x.id)], nextCursor: r.columns[0].nextCursor } : c));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-sm">
        <label className="flex items-center gap-1">Group by
          <select className={input} value={group} onChange={(e) => setGroup(e.target.value as Group)}>
            <option value="status">Status</option><option value="type">Type</option><option value="owner">Owner</option><option value="feature">Feature</option>
          </select>
        </label>
        {/* FH-158: export what this board shows */}
        <button className={btn} onClick={async () => {
          try { const n = await downloadExport({ viewSpec: { ...spec, view: 'board' }, columns: ['number', 'title', 'status', 'type', 'owner', 'feature'] }); setMsg(`Exported ${fmtCount(n)} ideas.`); }
          catch (e) { setMsg((e as Error).message); }
        }}>Export what this board shows</button>
        {q.isLoading && <span role="status">Loading…</span>}
      </div>
      {msg && <p role="alert" className="border-b border-[var(--border)] px-3 py-1 text-sm">{msg} <button className="underline" onClick={() => setMsg('')}>Dismiss</button></p>}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {columns.map((c) => (
          <BoardColumn key={c.key ?? 'none'} col={c} title={label(c.key)} draggable={isAdmin && group === 'status'} isAdmin={isAdmin && group === 'status'}
            onDrop={(id) => c.key && move(id, c.key as StatusKey)} onMove={move} onOpen={onOpen} onLoadMore={() => loadMore(c)} />
        ))}
      </div>
    </div>
  );
}

function BoardColumn({ col, title, draggable, isAdmin, onDrop, onMove, onOpen, onLoadMore }: {
  col: Column; title: string; draggable: boolean; isAdmin: boolean; onDrop: (id: string) => void; onMove: (id: string, to: StatusKey) => void;
  onOpen: (id: string) => void; onLoadMore: () => Promise<void> | void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: col.ids.length, getScrollElement: () => ref.current, estimateSize: () => 92, overscan: 6 });
  const items = v.getVirtualItems();
  const last = items[items.length - 1]?.index ?? 0;
  const loading = useRef(false);
  useEffect(() => {
    if (!col.nextCursor || loading.current || last < col.ids.length - 5) return;
    loading.current = true;
    Promise.resolve(onLoadMore()).finally(() => { loading.current = false; });
  }, [last, col.ids.length, col.nextCursor, onLoadMore]);
  const [over, setOver] = useState(false);
  return (
    <section aria-label={title} className={`flex w-72 shrink-0 flex-col rounded-lg border ${over ? 'border-[var(--accent)]' : 'border-[var(--border)]'} bg-[var(--panel)]`}
      onDragOver={(e) => { if (draggable) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { setOver(false); const id = e.dataTransfer.getData('text/plain'); if (id) onDrop(id); }}>
      <h3 className="flex items-center justify-between px-3 py-2 text-sm font-semibold">
        <span className="truncate">{title}</span><span className="text-xs tabular-nums text-[var(--muted)]">{col.total ?? col.ids.length}</span>
      </h3>
      <div ref={ref} className="min-h-24 flex-1 overflow-y-auto px-2 pb-2">
        <ul style={{ height: v.getTotalSize(), position: 'relative' }}>
          {items.map((it) => (
            <li key={col.ids[it.index]} className="absolute left-0 w-full px-0.5" style={{ top: it.start, height: 88 }}>
              <Card id={col.ids[it.index]} draggable={draggable} isAdmin={isAdmin} onOpen={onOpen} onMove={onMove} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Card({ id, draggable, isAdmin, onOpen, onMove }: { id: string; draggable: boolean; isAdmin: boolean; onOpen: (id: string) => void; onMove: (id: string, to: StatusKey) => void }) {
  const row = useRow(id);
  if (!row) return null;
  const key = statusKeyOf(row);
  return (
    <article draggable={draggable} onDragStart={(e) => e.dataTransfer.setData('text/plain', id)}
      className="h-[84px] rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 text-sm">
      <button className="line-clamp-2 text-left font-medium hover:underline" onClick={() => onOpen(id)}>#{row.number} {row.title}</button>
      <div className="mt-1 flex items-center gap-2">
        <StatusPill status={key} />
        {isAdmin && key && (
          <select aria-label={`Move #${row.number} to status`} className="ml-auto max-w-32 rounded border border-[var(--border)] bg-[var(--bg)] text-xs" value=""
            onChange={(e) => e.target.value && onMove(id, e.target.value as StatusKey)}>
            <option value="">Move to status…</option>
            {allowedTargets(key).filter((k) => k !== key).map((k) => <option key={k} value={k}>{statusLabel(k)}</option>)}
          </select>
        )}
      </div>
    </article>
  );
}
