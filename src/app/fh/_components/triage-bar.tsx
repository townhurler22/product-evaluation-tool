'use client';

// Triage toolbar (FH-403, FH-404): a Source quick filter (the same filter as the Source column) and
// "Accept all from calls / support (n)", which accepts in chunks of 200 and keeps the ideas in Triage.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SOURCE_LABEL } from '@/modules/fh/domain';
import type { ViewSpecInput } from '@/modules/fh/columns';
import type { IdeaRow } from '@/modules/fh/rows';
import { api, specParam } from '../_lib/api';
import { keys } from '../_lib/data';
import { rowStore } from '../_lib/rows';
import { fmtCount, runChunks } from '../_lib/selection';
import { btn } from './ui';
import type { Filters } from './ideas-workspace';

interface Counts { sources: { value: string; count: number }[]; unreviewedCalls: number; unreviewedSupport: number }

export default function TriageBar({ spec, filters, onFilters, isAdmin, onMessage }: {
  spec: ViewSpecInput; filters: Filters; onFilters: (f: Filters) => void; isAdmin: boolean; onMessage: (t: string) => void;
}) {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<string | null>(null);
  const counts = useQuery({
    queryKey: ['fh', 'triage-counts', JSON.stringify(spec)], staleTime: 15_000,
    queryFn: () => api<Counts>(`/api/fh/ideas/triage-counts?${specParam(spec)}`),
  });
  const active = filters.source ?? [];
  const setSource = (value: string | null) => {
    const next = { ...filters };
    if (value === null) delete next.source; else next.source = [value];
    onFilters(next);
  };

  async function acceptAll(source: 'CALL' | 'SUPPORT_BUTTON', n: number) {
    const what = source === 'CALL' ? 'call requests' : 'support submissions';
    if (!window.confirm(`Accept ${fmtCount(n)} ${what}? They stay in Triage.`)) return;
    const viewSpec: ViewSpecInput = { ...spec, filters: { ...(spec.filters ?? {}), triage: ['UNREVIEWED'], source: [source] } };
    try {
      const { ids, total } = await api<{ ids: string[]; total: number }>('/api/fh/ideas/ids', { method: 'POST', body: { viewSpec } });
      const res = await runChunks(ids, async (chunk) => {
        const r = await api<{ rows: IdeaRow[] }>('/api/fh/ideas/bulk/accept', { method: 'POST', body: { ids: chunk } });
        rowStore.upsert(r.rows);
        return r;
      }, (p) => setProgress(`Accepting ${fmtCount(p.done)} of ${fmtCount(p.total)}…`));
      const more = total > ids.length ? ` ${fmtCount(total - ids.length)} more remain; run it again.` : '';
      onMessage(res.error
        ? `Accepted ${fmtCount(res.done)} of ${fmtCount(res.total)}, then stopped: ${res.error.message}`
        : `Accepted ${fmtCount(res.done)} ${what}.${more}`);
    } catch (e) {
      onMessage((e as Error).message);
    } finally {
      setProgress(null);
      qc.invalidateQueries({ queryKey: ['fh', 'triage-counts'] });
      qc.invalidateQueries({ queryKey: keys.ideasAll });
    }
  }

  const c = counts.data;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-sm">
      <div role="group" aria-label="Source quick filter" className="flex flex-wrap gap-1">
        <button className={btn} aria-pressed={!active.length} onClick={() => setSource(null)}>All</button>
        {c?.sources.map((s) => (
          <button key={s.value} className={btn} aria-pressed={active.length === 1 && active[0] === s.value} onClick={() => setSource(s.value)}>
            {SOURCE_LABEL[s.value as keyof typeof SOURCE_LABEL] ?? s.value} ({fmtCount(s.count)})
          </button>
        ))}
      </div>
      {isAdmin && c && (
        <div className="ml-auto flex flex-wrap gap-1">
          {c.unreviewedCalls > 0 && <button className={btn} disabled={!!progress} onClick={() => acceptAll('CALL', c.unreviewedCalls)}>Accept all from calls ({fmtCount(c.unreviewedCalls)})</button>}
          {c.unreviewedSupport > 0 && <button className={btn} disabled={!!progress} onClick={() => acceptAll('SUPPORT_BUTTON', c.unreviewedSupport)}>Accept all from support ({fmtCount(c.unreviewedSupport)})</button>}
        </div>
      )}
      <span role="status" aria-live="polite">{progress}</span>
    </div>
  );
}
