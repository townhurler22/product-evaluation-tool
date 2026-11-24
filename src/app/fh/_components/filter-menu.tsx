'use client';

// Column filter popover (FH-106, FH-107): facet values with counts from the server for the current view, fetched
// when the menu opens. High-cardinality columns are searchable on the server.
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { COLUMN_BY_ID, TRIAGE_LABEL, type ViewSpecInput } from '@/modules/fh/columns';
import { SOURCE_LABEL, statusLabel, TYPE_LABEL, type IdeaType, type StatusKey } from '@/modules/fh/domain';
import { api, specParam } from '../_lib/api';
import { keys, type Lookups } from '../_lib/data';
import { input } from './ui';

const NONE_LABEL: Record<string, string> = {
  owner: 'Unassigned', feature: 'No Feature', milestone: 'No milestone', companies: 'No companies', themes: 'No themes', journeys: 'No Journeys', triage: 'No flags',
};

function labelFor(col: string, value: string | null, label: string): string {
  if (value === null) return NONE_LABEL[col] ?? 'No value';
  switch (col) {
    case 'status': return statusLabel(value as StatusKey, true);
    case 'type': return TYPE_LABEL[value as IdeaType] ?? value;
    case 'source': return SOURCE_LABEL[value as keyof typeof SOURCE_LABEL] ?? value;
    case 'triage': return TRIAGE_LABEL[value as keyof typeof TRIAGE_LABEL] ?? value;
    case 'committed': case 'dealbreaker': return value === 'true' ? 'Yes' : 'No';
    default: return label || value;
  }
}

export default function FilterMenu({ col, x, y, spec, value, onChange, onClose }: {
  col: string; x: number; y: number; spec: ViewSpecInput; lookups?: Lookups; value: (string | null)[];
  onChange: (v: (string | null)[]) => void; onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  useEffect(() => { const t = setTimeout(() => setDq(q), 250); return () => clearTimeout(t); }, [q]);
  const searchable = col === 'owner' || col === 'companies';
  const baseSpec = { ...spec, filters: {} };
  const facets = useQuery({
    queryKey: keys.facets(baseSpec, col, dq),
    queryFn: () => api<{ facets: { value: string | null; label: string; count: number }[] }>(`/api/fh/ideas/facets?${specParam(baseSpec)}&column=${col}${dq ? `&q=${encodeURIComponent(dq)}` : ''}`),
    staleTime: 30_000,
  });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input')?.focus();
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const set = new Set(value);
  const toggle = (v: string | null) => {
    const s = new Set(set);
    if (s.has(v)) s.delete(v); else s.add(v);
    onChange([...s]);
  };
  const left = typeof window !== 'undefined' ? Math.min(x, window.innerWidth - 280) : x;
  return (
    <div ref={ref} role="dialog" aria-label={`Filter ${COLUMN_BY_ID[col]?.label}`} className="fixed z-40 w-64 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 shadow-lg" style={{ left: Math.max(8, left), top: y + 4 }}>
      <p className="mb-1 text-sm font-semibold">Filter {COLUMN_BY_ID[col]?.label}</p>
      {searchable && <input className={`${input} mb-1 w-full`} placeholder="Search" aria-label="Search values" value={q} onChange={(e) => setQ(e.target.value)} />}
      {facets.isLoading && <p className="text-sm text-[var(--muted)]">Loading…</p>}
      {facets.isError && <p role="alert" className="text-sm text-[var(--danger)]">Could not load values.</p>}
      <ul className="max-h-72 overflow-auto">
        {facets.data?.facets.map((f) => (
          <li key={f.value ?? 'none'}>
            <label className="flex items-center gap-2 py-0.5 text-sm">
              <input type="checkbox" checked={set.has(f.value)} onChange={() => toggle(f.value)} />
              <span className="min-w-0 flex-1 truncate">{labelFor(col, f.value, f.label)}</span>
              <span className="tabular-nums text-xs text-[var(--muted)]">{f.count}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex justify-between">
        <button className="text-sm underline" onClick={() => onChange([])}>Clear</button>
        <button className="text-sm underline" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
