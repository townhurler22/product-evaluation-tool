'use client';

// Roadmap Gantt (FH-761–768). Own light theme scoped to its container (FH-008). Bars drag to move or resize, with a
// date-field dialog as the non-drag alternative (NFR-02). The dates operation never changes status.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, daysBetween, IDEA_TYPES, releaseTrainDates, todayUtc, TYPE_LABEL, type IdeaType } from '@/modules/fh/domain';
import type { ViewSpecInput } from '@/modules/fh/columns';
import type { IdeaRow } from '@/modules/fh/rows';
import { barGeometry, initialWindowStart, panStep, snapDays, ticks, ZOOM_LABEL, ZOOMS, type Zoom } from '@/modules/fh/timeline';
import { api, specParam } from '../_lib/api';
import { keys, type Lookups, type Milestone } from '../_lib/data';
import { rowStore, useRow } from '../_lib/rows';
import { btn, btnPrimary, Dialog, input, shortDate } from './ui';

const LABEL_W = 240;

export default function Roadmap({ spec, lookups, isAdmin, onOpen, filterCount, onClearFilters }: {
  spec: ViewSpecInput; lookups: Lookups; isAdmin: boolean; onOpen: (id: string) => void; filterCount: number; onClearFilters: () => void;
}) {
  const today = todayUtc();
  const [zoom, setZoom] = useState<Zoom>('8w');
  const [from, setFrom] = useState(() => initialWindowStart('8w', today, lookups.settings.planningYearStartMonth));
  const [hidden, setHidden] = useState<Set<IdeaType>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [milestones, setMilestones] = useState(false);
  const [msg, setMsg] = useState('');
  const days = ZOOMS[zoom];
  const to = addDays(from, days - 1);
  // The server returns ideas overlapping the window plus one window either side (FH-761).
  const qFrom = addDays(from, -days), qTo = addDays(to, days);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth - LABEL_W)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const dayW = width / days;

  const q = useQuery({
    queryKey: keys.roadmap(spec, qFrom, qTo), staleTime: 30_000,
    queryFn: async () => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const r: { rows: IdeaRow[]; nextCursor: string | null } = await api(`/api/fh/roadmap?${specParam(spec)}&from=${qFrom}&to=${qTo}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        rowStore.upsert(r.rows);
        ids.push(...r.rows.map((x) => x.id));
        cursor = r.nextCursor;
      } while (cursor && ids.length < 2000);
      return ids;
    },
  });

  const setZoomTo = (z: Zoom) => { setZoom(z); setFrom(initialWindowStart(z, today, lookups.settings.planningYearStartMonth)); };
  const train = useMemo(() => releaseTrainDates(lookups.settings.releaseTrain.anchor, lookups.settings.releaseTrain.lengthDays, from, to), [lookups.settings, from, to]);
  const x = (d: string) => daysBetween(from, d) * dayW;

  return (
    <div className="fh-light-scope flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-sm">
        <div role="group" aria-label="Zoom" className="flex gap-1">
          {(Object.keys(ZOOMS) as Zoom[]).map((z) => <button key={z} className={btn} aria-pressed={z === zoom} onClick={() => setZoomTo(z)}>{ZOOM_LABEL[z]}</button>)}
        </div>
        <button className={btn} aria-label="Earlier" onClick={() => setFrom(addDays(from, -panStep(zoom)))}>◀</button>
        <span className="tabular-nums">{shortDate(from)} to {shortDate(to)}</span>
        <button className={btn} aria-label="Later" onClick={() => setFrom(addDays(from, panStep(zoom)))}>▶</button>
        <div role="group" aria-label="Types" className="flex flex-wrap gap-1">
          {IDEA_TYPES.map((t) => (
            <button key={t} className={btn} aria-pressed={!hidden.has(t)} onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(t)) n.delete(t); else n.add(t); return n; })}>
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
        {filterCount > 0 && <button className={btn} onClick={onClearFilters}>Clear filters ({filterCount})</button>}
        {isAdmin && <button className={btn} onClick={() => setMilestones(true)}>Milestones…</button>}
      </div>
      {msg && <p role="alert" className="border-b border-[var(--border)] px-3 py-1 text-sm">{msg} <button className="underline" onClick={() => setMsg('')}>Dismiss</button></p>}
      <div ref={wrap} className="min-h-0 flex-1 overflow-auto">
        <div className="relative" style={{ minWidth: LABEL_W + width }}>
          <div className="sticky top-0 z-10 flex border-b border-[var(--border)] bg-[var(--bg)] text-xs">
            <div className="shrink-0 px-2 py-1 font-semibold" style={{ width: LABEL_W }}>Idea</div>
            <div className="relative h-7" style={{ width }}>
              {ticks(zoom, from).map((d) => (
                <span key={d} className="absolute top-1 whitespace-nowrap text-[var(--muted)]" style={{ left: x(d) + 2 }}>
                  {zoom === '2w' ? d.slice(8) : zoom === '8w' ? shortDate(d).replace(/ \d{4}$/, '') : new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}
                </span>
              ))}
            </div>
          </div>
          <div className="relative">
            <Overlay left={LABEL_W} from={from} to={to} x={x} today={today} train={train} milestones={lookups.milestones} />
            {q.isLoading && <p className="p-3 text-sm">Loading…</p>}
            {q.data && !q.data.length && <p className="p-3 text-sm text-[var(--muted)]">No roadmap ideas in this window. Ideas appear here once they are Planned, In progress or Complete (or bugs In development, Fixed or Released) and have a start date.</p>}
            <ul aria-label="Roadmap">
              {q.data?.map((id) => <GanttRow key={id} id={id} from={from} days={days} dayW={dayW} width={width} hidden={hidden} isAdmin={isAdmin}
                onOpen={onOpen} onEdit={setEditing} onError={setMsg} />)}
            </ul>
          </div>
        </div>
      </div>
      {editing && <DatesDialog id={editing} onClose={() => setEditing(null)} onError={setMsg} />}
      {milestones && <MilestonesDialog list={lookups.milestones} onClose={() => setMilestones(false)} />}
    </div>
  );
}

function Overlay({ left, from, to, x, today, train, milestones }: { left: number; from: string; to: string; x: (d: string) => number; today: string; train: string[]; milestones: Milestone[] }) {
  const inWin = (d: string) => d >= from && d <= to;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-y-0" style={{ left, right: 0 }}>
      {train.map((d) => <div key={`t${d}`} title={`Release ${shortDate(d)}`} className="absolute inset-y-0 border-l border-dashed border-teal-600" style={{ left: x(d) }} />)}
      {milestones.filter((m) => inWin(m.date)).map((m) => (
        <div key={m.id} className="absolute inset-y-0 border-l-2" style={{ left: x(m.date), borderColor: m.colour && /^#[0-9a-f]{6}$/.test(m.colour) ? m.colour : '#4338ca' }}>
          <span className="ml-1 whitespace-nowrap bg-white/80 text-[10px]">{m.name}</span>
        </div>
      ))}
      {inWin(today) && <div className="absolute inset-y-0 border-l-2 border-red-600" style={{ left: x(today) }}><span className="ml-1 bg-white/80 text-[10px] text-red-700">Today</span></div>}
    </div>
  );
}

function GanttRow({ id, from, days, dayW, width, hidden, isAdmin, onOpen, onEdit, onError }: {
  id: string; from: string; days: number; dayW: number; width: number; hidden: Set<IdeaType>; isAdmin: boolean;
  onOpen: (id: string) => void; onEdit: (id: string) => void; onError: (m: string) => void;
}) {
  const row = useRow(id);
  const [drag, setDrag] = useState<{ mode: 'move' | 'start' | 'end'; x0: number; dx: number } | null>(null);
  if (!row || !row.startDate || hidden.has(row.ideaType)) return null;
  const delta = drag ? snapDays(drag.dx, dayW) : 0;
  let start = row.startDate, due = row.dueDate ?? row.startDate;
  if (drag?.mode === 'move') { start = addDays(start, delta); due = addDays(due, delta); }
  if (drag?.mode === 'start') start = addDays(start, delta) > due ? due : addDays(start, delta);
  if (drag?.mode === 'end') due = addDays(due, delta) < start ? start : addDays(due, delta);
  const bar = barGeometry(start, due, from, days, dayW);

  const begin = (mode: 'move' | 'start' | 'end') => (e: React.PointerEvent) => {
    if (!isAdmin) return;
    e.preventDefault(); e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ mode, x0: e.clientX, dx: 0 });
  };
  const moveP = (e: React.PointerEvent) => { if (drag) setDrag({ ...drag, dx: e.clientX - drag.x0 }); };
  const end = async () => {
    if (!drag) return;
    setDrag(null);
    if (!delta) return;
    try {
      const r = await api<{ row: IdeaRow }>(`/api/fh/ideas/${id}/dates`, { method: 'PUT', body: { startDate: start, dueDate: due, baseVersion: row.version } });
      rowStore.upsert([r.row]);
    } catch (e) { onError((e as Error).message); }
  };

  return (
    <li className="flex h-9 items-center border-b border-[var(--border)] text-sm">
      <div className="flex shrink-0 items-center gap-1 truncate px-2" style={{ width: LABEL_W }}>
        {row.isCommitted && <span aria-label="Committed" title="Committed">🔒</span>}
        <button className="truncate text-left hover:underline" title={row.title} onClick={() => onOpen(id)}>{row.title}</button>
        {isAdmin && <button className="ml-auto shrink-0 text-xs underline" onClick={() => onEdit(id)} aria-label={`Edit dates for ${row.title}`}>Dates</button>}
      </div>
      <div className="relative h-full" style={{ width }}>
        {bar && (
          <div onPointerDown={begin('move')} onPointerMove={moveP} onPointerUp={end} onPointerCancel={() => setDrag(null)}
            title={`${row.title}: ${shortDate(start)} to ${shortDate(due)}`}
            className={`absolute top-1.5 h-6 rounded bg-indigo-500 text-white ${isAdmin ? 'cursor-grab' : ''} ${bar.clippedStart ? 'rounded-l-none border-l-4 border-indigo-900' : ''} ${bar.clippedEnd ? 'rounded-r-none border-r-4 border-indigo-900' : ''}`}
            style={{ left: bar.left, width: bar.width }}>
            <span className="block truncate px-1 text-xs leading-6">Finish {shortDate(due)}</span>
            {isAdmin && !bar.clippedStart && <span onPointerDown={begin('start')} onPointerMove={moveP} onPointerUp={end} className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" />}
            {isAdmin && !bar.clippedEnd && <span onPointerDown={begin('end')} onPointerMove={moveP} onPointerUp={end} className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" />}
          </div>
        )}
      </div>
    </li>
  );
}

function DatesDialog({ id, onClose, onError }: { id: string; onClose: () => void; onError: (m: string) => void }) {
  const row = useRow(id);
  const [start, setStart] = useState(row?.startDate ?? '');
  const [due, setDue] = useState(row?.dueDate ?? row?.startDate ?? '');
  const [err, setErr] = useState('');
  if (!row) return null;
  return (
    <Dialog title={`Dates for #${row.number}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        try {
          const r = await api<{ row: IdeaRow }>(`/api/fh/ideas/${id}/dates`, { method: 'PUT', body: { startDate: start, dueDate: due, baseVersion: row.version } });
          rowStore.upsert([r.row]); onClose();
        } catch (x) { setErr((x as Error).message); onError(''); }
      }}>
        <label className="block text-sm">Start<input type="date" required className={`${input} mt-1 w-full`} value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="block text-sm">Due<input type="date" required className={`${input} mt-1 w-full`} value={due} onChange={(e) => setDue(e.target.value)} aria-describedby={err ? 'dates-err' : undefined} /></label>
        {err && <p id="dates-err" role="alert" className="text-sm text-[var(--danger)]">{err}</p>}
        <div className="flex justify-end gap-2"><button type="button" className={btn} onClick={onClose}>Cancel</button><button type="submit" className={btnPrimary}>Save</button></div>
      </form>
    </Dialog>
  );
}

/** FH-768: create, edit and delete milestones from the Roadmap toolbar. */
function MilestonesDialog({ list, onClose }: { list: Milestone[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [date, setDate] = useState(todayUtc());
  const [colour, setColour] = useState('#4338ca');
  const [err, setErr] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: keys.lookups });
  return (
    <Dialog title="Milestones" onClose={onClose} wide>
      <ul className="mb-3 space-y-1 text-sm">
        {list.length === 0 && <li className="text-[var(--muted)]">No milestones yet.</li>}
        {list.map((m) => (
          <li key={m.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{m.name} · {shortDate(m.date)} · {m.ideaCount} ideas</span>
            <button className="text-xs underline" onClick={async () => { const n = window.prompt('Rename milestone', m.name); if (n) { await api(`/api/fh/milestones/${m.id}`, { method: 'PATCH', body: { name: n } }).catch((e) => setErr(e.message)); refresh(); } }}>Rename</button>
            <button className="text-xs underline" onClick={async () => { const d = window.prompt('New date (YYYY-MM-DD)', m.date); if (d) { await api(`/api/fh/milestones/${m.id}`, { method: 'PATCH', body: { date: d } }).catch((e) => setErr(e.message)); refresh(); } }}>Change date</button>
            <button className="text-xs text-[var(--danger)] underline" onClick={async () => { if (window.confirm(`Delete "${m.name}"? ${m.ideaCount} ideas will be detached.`)) { await api(`/api/fh/milestones/${m.id}`, { method: 'DELETE' }).catch((e) => setErr(e.message)); refresh(); } }}>Delete</button>
          </li>
        ))}
      </ul>
      <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => {
        e.preventDefault();
        try { await api('/api/fh/milestones', { method: 'POST', body: { name, date, colour } }); setName(''); setErr(''); refresh(); } catch (x) { setErr((x as Error).message); }
      }}>
        <label className="text-sm">Name<input className={`${input} mt-1 block`} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required /></label>
        <label className="text-sm">Date<input type="date" className={`${input} mt-1 block`} value={date} onChange={(e) => setDate(e.target.value)} required /></label>
        <label className="text-sm">Colour<input type="color" className="mt-1 block h-8 w-12" value={colour} onChange={(e) => setColour(e.target.value)} /></label>
        <button type="submit" className={btnPrimary}>Add milestone</button>
      </form>
      {err && <p role="alert" className="mt-2 text-sm text-[var(--danger)]">{err}</p>}
    </Dialog>
  );
}
