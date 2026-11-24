'use client';

// The one shared cell editor (PERF-11, D-08): mounted only while a cell is being edited, positioned over it.
// Enter commits, Esc cancels, Tab commits (NFR-03).
import { useEffect, useMemo, useRef, useState } from 'react';
import { COLUMN_BY_ID } from '@/modules/fh/columns';
import type { Lookups } from '../_lib/data';
import { api } from '../_lib/api';
import type { EditValue } from '../_lib/edit';
import { useRow } from '../_lib/rows';
import { currentValue, optionsFor } from './cells';
import { input } from './ui';

export default function CellEditor({ rowId, col, lookups, anchor, onCommit, onCancel, onMessage }: {
  rowId: string; col: string; lookups: Lookups; anchor: HTMLElement | null;
  onCommit: (v: EditValue) => void; onCancel: () => void; onMessage: (t: string) => void;
}) {
  const row = useRow(rowId);
  const kind = COLUMN_BY_ID[col]?.edit;
  const rect = anchor?.getBoundingClientRect();
  const style = rect ? { left: Math.min(rect.left, window.innerWidth - 300), top: rect.top, minWidth: Math.max(rect.width, 200) } : { left: 16, top: 120 };
  void onMessage;
  if (!row || !kind) return null;
  return (
    <div className="fixed z-40 rounded-md border border-[var(--accent)] bg-[var(--bg)] shadow-lg" style={style}>
      {(kind === 'text' || kind === 'score' || kind === 'int' || kind === 'date') && (
        <ScalarEditor kind={kind} initial={(row as unknown as Record<string, unknown>)[col] as string | number | null} onCommit={onCommit} onCancel={onCancel} label={COLUMN_BY_ID[col].label} />
      )}
      {['status', 'type', 'owner', 'feature', 'milestone'].includes(kind) && (
        <OptionList options={optionsFor(col, row, lookups)} current={currentValue(col, row)} label={COLUMN_BY_ID[col].label}
          onPick={(v) => onCommit(v)} onCancel={onCancel} />
      )}
      {kind === 'themes' && (
        <MultiPick label="Themes" options={lookups.themes.map((t) => ({ value: t.id, label: t.name }))} initial={row.themeIds} max={20} onCommit={onCommit} onCancel={onCancel} />
      )}
      {kind === 'companies' && <CompanyPick initial={row.companies} onCommit={onCommit} onCancel={onCancel} />}
    </div>
  );
}

function ScalarEditor({ kind, initial, onCommit, onCancel, label }: { kind: string; initial: string | number | null; onCommit: (v: EditValue) => void; onCancel: () => void; label: string }) {
  const [v, setV] = useState(initial === null || initial === undefined ? '' : String(initial));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select?.(); }, []);
  const value = (): EditValue => {
    if (kind === 'text') return v;
    if (kind === 'date') return v || null;
    return v.trim() === '' ? null : Number(v);
  };
  return (
    <input ref={ref} aria-label={label} className={`${input} w-full`} value={v}
      type={kind === 'date' ? 'date' : kind === 'text' ? 'text' : 'number'} min={kind === 'score' ? 1 : 0} max={kind === 'score' ? 10 : 3650} maxLength={kind === 'text' ? 200 : undefined}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); onCommit(value()); }
      }}
      onBlur={() => onCancel()} />
  );
}

export function OptionList({ options, current, label, onPick, onCancel }: {
  options: { value: string | null; label: string; depth?: number }[]; current: string | null; label: string; onPick: (v: string | null) => void; onCancel: () => void;
}) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())), [options, q]);
  const [i, setI] = useState(Math.max(0, options.findIndex((o) => o.value === current)));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="w-72 p-1">
      <input ref={ref} className={`${input} mb-1 w-full`} placeholder={`Find ${label.toLowerCase()}`} aria-label={`Find ${label}`} value={q}
        role="combobox" aria-expanded aria-controls="cell-options" aria-activedescendant={shown[i] ? `opt-${i}` : undefined}
        onChange={(e) => { setQ(e.target.value); setI(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(shown.length - 1, x + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
          if (e.key === 'Enter' && shown[i]) { e.preventDefault(); onPick(shown[i].value); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        onBlur={(e) => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) onCancel(); }} />
      <ul id="cell-options" role="listbox" aria-label={label} className="max-h-64 overflow-auto">
        {shown.map((o, k) => (
          <li key={o.value ?? 'none'} id={`opt-${k}`} role="option" aria-selected={o.value === current}
            onMouseDown={(e) => { e.preventDefault(); onPick(o.value); }}
            className={`cursor-pointer truncate rounded px-2 py-1 text-sm ${k === i ? 'bg-[var(--hover)]' : ''} ${o.value === current ? 'font-semibold' : ''}`}
            style={{ paddingLeft: 8 + (o.depth ?? 0) * 14 }}>{o.label}</li>
        ))}
        {!shown.length && <li className="px-2 py-1 text-sm text-[var(--muted)]">No matches</li>}
      </ul>
    </div>
  );
}

export function MultiPick({ label, options, initial, max, onCommit, onCancel }: {
  label: string; options: { value: string; label: string }[]; initial: string[]; max: number; onCommit: (v: string[]) => void; onCancel: () => void;
}) {
  const [sel, setSel] = useState(new Set(initial));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLInputElement>('input')?.focus(); }, []);
  return (
    <div ref={ref} className="w-72 p-2" role="group" aria-label={label}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }}>
      <div className="max-h-60 space-y-1 overflow-auto">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sel.has(o.value)} onChange={(e) => {
              const s = new Set(sel);
              if (e.target.checked) { if (s.size < max) s.add(o.value); } else s.delete(o.value);
              setSel(s);
            }} />
            {o.label}
          </label>
        ))}
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button className="rounded border border-[var(--border)] px-2 py-1 text-sm" onClick={onCancel}>Cancel</button>
        <button className="rounded bg-[var(--accent)] px-2 py-1 text-sm text-[var(--accent-fg)]" onClick={() => onCommit([...sel])}>Apply</button>
      </div>
    </div>
  );
}

/** Companies are searched on the server (D-10): never the whole list. */
export function CompanyPick({ initial, onCommit, onCancel, max = 100 }: {
  initial: { id: string; name: string }[]; onCommit: (ids: string[], chosen: { id: string; name: string }[]) => void; onCancel: () => void; max?: number;
}) {
  const [chosen, setChosen] = useState(initial);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    const t = setTimeout(async () => {
      try { setResults((await api<{ companies: { id: string; name: string }[] }>(`/api/fh/companies?q=${encodeURIComponent(q)}`)).companies); } catch { setResults([]); }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="w-80 p-2" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }}>
      <div className="mb-2 flex flex-wrap gap-1">
        {chosen.map((c) => (
          <button key={c.id} className="rounded-full border border-[var(--border)] px-2 text-xs" aria-label={`Remove ${c.name}`} onClick={() => setChosen(chosen.filter((x) => x.id !== c.id))}>{c.name} ×</button>
        ))}
      </div>
      <input autoFocus className={`${input} w-full`} placeholder="Search companies" aria-label="Search companies" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="mt-1 max-h-52 overflow-auto">
        {results.filter((r) => !chosen.some((c) => c.id === r.id)).map((r) => (
          <li key={r.id}><button className="w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-[var(--hover)]" onClick={() => setChosen(max === 1 ? [r] : chosen.length < max ? [...chosen, r] : chosen)}>{r.name}</button></li>
        ))}
      </ul>
      <div className="mt-2 flex justify-end gap-2">
        <button className="rounded border border-[var(--border)] px-2 py-1 text-sm" onClick={onCancel}>Cancel</button>
        <button className="rounded bg-[var(--accent)] px-2 py-1 text-sm text-[var(--accent-fg)]" onClick={() => onCommit(chosen.map((c) => c.id), chosen)}>Apply</button>
      </div>
    </div>
  );
}
