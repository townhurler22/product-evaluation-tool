'use client';

// Reporting (FH-851 to FH-854). Every number comes from the server's materialised view; the page never recounts.
// Theme trends: stacked weekly bars, the top 7 themes in fixed palette slots plus "Other", a legend, per-segment
// hover and focus details, and a table view for screen readers and anyone who prefers numbers.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../_lib/api';
import { useLookups } from '../_lib/data';
import { fmtCount } from '../_lib/selection';
import { btn, money } from './ui';

interface Report {
  tiles: { total: number; completed: number; incomplete: number; dealbreakers: number };
  themeTrends: { weeks: string[]; themes: { id: string; name: string; colour: string | null; counts: number[] }[] };
  demandByFeature: { id: string; name: string; depth: number; openCount: number; arr: string }[];
  refreshedAt: string | null;
}

// Validated categorical slots (light / dark), assigned in fixed order by each theme's overall size, never cycled.
const SLOTS = 7;
const OTHER = 'other';

function ago(iso: string | null): string {
  if (!iso) return 'Not refreshed yet';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 1 ? 'Updated just now' : `Updated ${m} minute${m === 1 ? '' : 's'} ago`;
}
const weekLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export default function Reporting() {
  const lookups = useLookups();
  const currency = lookups.data?.settings.currency ?? 'EUR';
  const r = useQuery({ queryKey: ['fh', 'reporting'], queryFn: () => api<Report>('/api/fh/reporting'), staleTime: 60_000, refetchInterval: 5 * 60_000 });
  const d = r.data;
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-bold">Reporting</h1>
        <p className="text-sm text-[var(--muted)]">{d ? ago(d.refreshedAt) : ''}. Live ideas only; figures refresh every 5 minutes.</p>
      </div>
      {r.isLoading && <p>Loading…</p>}
      {r.isError && <p className="text-[var(--danger)]">Reporting could not be loaded.</p>}
      {d && (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {([['Total', d.tiles.total], ['Completed', d.tiles.completed], ['Incomplete', d.tiles.incomplete], ['Dealbreakers', d.tiles.dealbreakers]] as const).map(([label, n]) => (
              <div key={label} className="rounded-lg border border-[var(--border)] p-3">
                <dt className="text-sm text-[var(--muted)]">{label}</dt>
                <dd className="text-3xl font-bold tabular-nums">{fmtCount(n)}</dd>
              </div>
            ))}
          </dl>
          <ThemeTrends trends={d.themeTrends} />
          <section aria-labelledby="demand-h">
            <h2 id="demand-h" className="text-lg font-semibold">Demand by Feature</h2>
            <p className="text-sm text-[var(--muted)]">Top 20 Features by open ideas, including sub-features, with the ARR of the companies who asked.</p>
            {d.demandByFeature.length ? (
              <div className="mt-2 overflow-x-auto rounded-md border border-[var(--border)]">
                <table className="w-full min-w-[420px] text-sm">
                  <thead className="bg-[var(--panel)] text-left"><tr><th className="px-2 py-1">Feature</th><th className="px-2 py-1 text-right">Open ideas</th><th className="px-2 py-1 text-right">ARR</th></tr></thead>
                  <tbody>{d.demandByFeature.map((f) => (
                    <tr key={f.id} className="border-t border-[var(--border)]">
                      <td className="px-2 py-1"><a className="underline" href={`/fh/ideas?feature=${f.id}`}>{f.name}</a></td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtCount(f.openCount)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{money(f.arr, currency)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <p className="mt-2 text-sm text-[var(--muted)]">No open ideas are linked to Features yet.</p>}
          </section>
        </>
      )}
    </main>
  );
}

function ThemeTrends({ trends }: { trends: Report['themeTrends'] }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<{ week: number; series: string } | null>(null);

  // Slots follow the theme (its rank over all themes), so filtering never repaints the survivors.
  const series = useMemo(() => {
    const top = trends.themes.slice(0, SLOTS).map((t, i) => ({ id: t.id, name: t.name, slot: i + 1, counts: t.counts }));
    const rest = trends.themes.slice(SLOTS);
    if (rest.length) {
      top.push({ id: OTHER, name: `Other (${rest.length} themes)`, slot: 0, counts: trends.weeks.map((_, w) => rest.reduce((n, t) => n + t.counts[w], 0)) });
    }
    return top;
  }, [trends]);
  const shown = series.filter((s) => !hidden.has(s.id));
  const totals = trends.weeks.map((_, w) => shown.reduce((n, s) => n + s.counts[w], 0));
  const max = Math.max(1, ...totals);
  const W = 720, H = 240, padL = 32, padB = 28, padT = 8;
  const bw = (W - padL) / trends.weeks.length;
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, Math.ceil(max / 2), max];

  return (
    <section aria-labelledby="trends-h" className="space-y-2">
      <style>{`
        .viz { --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --s5:#e87ba4; --s6:#008300; --s7:#6250d6; --s0:#8a8984; --gap: var(--bg); }
        @media (prefers-color-scheme: dark) { .viz { --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; --s6:#0ca30c; --s7:#9085e9; --s0:#6f6e69; } }
      `}</style>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="trends-h" className="text-lg font-semibold">Theme trends</h2>
        <span className="text-sm text-[var(--muted)]">Ideas per theme by week created, last 26 weeks</span>
        <button className={`${btn} ml-auto`} aria-pressed={table} onClick={() => setTable((t) => !t)}>{table ? 'Show chart' : 'Show table'}</button>
      </div>
      {!series.length ? <p className="text-sm text-[var(--muted)]">No themed ideas in the last 26 weeks.</p> : (
        <div className="viz space-y-2">
          <div role="group" aria-label="Theme filter" className="flex flex-wrap gap-1">
            {series.map((s) => (
              <button key={s.id} className={`${btn} gap-1.5`} aria-pressed={!hidden.has(s.id)}
                onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })}>
                <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: `var(--s${s.slot})` }} />{s.name}
              </button>
            ))}
          </div>
          {table ? (
            <div className="overflow-x-auto rounded-md border border-[var(--border)]">
              <table className="w-full text-sm">
                <thead className="bg-[var(--panel)]"><tr><th className="px-2 py-1 text-left">Week of</th>{shown.map((s) => <th key={s.id} className="px-2 py-1 text-right">{s.name}</th>)}<th className="px-2 py-1 text-right">Total</th></tr></thead>
                <tbody>{trends.weeks.map((w, i) => (
                  <tr key={w} className="border-t border-[var(--border)]"><td className="px-2 py-1">{weekLabel(w)}</td>
                    {shown.map((s) => <td key={s.id} className="px-2 py-1 text-right tabular-nums">{s.counts[i]}</td>)}
                    <td className="px-2 py-1 text-right font-semibold tabular-nums">{totals[i]}</td></tr>
                ))}</tbody>
              </table>
            </div>
          ) : (
            <div className="relative">
              <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Stacked bar chart of ideas per theme per week. Use Show table for the numbers.">
                {ticks.map((t) => (
                  <g key={t}>
                    <line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
                    <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">{t}</text>
                  </g>
                ))}
                {trends.weeks.map((w, i) => {
                  let acc = 0;
                  const x = padL + i * bw + 2, width = Math.max(2, bw - 4);
                  return (
                    <g key={w}>
                      {shown.map((s) => {
                        const v = s.counts[i];
                        if (!v) return null;
                        const top = y(acc + v), bottom = y(acc);
                        acc += v;
                        const active = hover?.week === i && hover.series === s.id;
                        return (
                          <rect key={s.id} x={x} y={top} width={width} height={Math.max(1, bottom - top - 2)} rx={2}
                            fill={`var(--s${s.slot})`} stroke={active ? 'var(--fg)' : 'none'} strokeWidth={active ? 1.5 : 0}
                            tabIndex={0} aria-label={`${s.name}, week of ${weekLabel(w)}: ${v}`}
                            onMouseEnter={() => setHover({ week: i, series: s.id })} onFocus={() => setHover({ week: i, series: s.id })}
                            onMouseLeave={() => setHover(null)} onBlur={() => setHover(null)} />
                        );
                      })}
                      {i % 4 === 0 && <text x={x + width / 2} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">{weekLabel(w)}</text>}
                    </g>
                  );
                })}
              </svg>
              <p aria-live="polite" className="min-h-5 text-sm">
                {hover ? (() => {
                  const s = series.find((x) => x.id === hover.series)!;
                  return `Week of ${weekLabel(trends.weeks[hover.week])}: ${s.name} ${s.counts[hover.week]} of ${totals[hover.week]} ideas`;
                })() : <span className="text-[var(--muted)]">Hover or focus a bar segment for its numbers.</span>}
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
