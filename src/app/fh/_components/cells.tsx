'use client';

// Cell rendering and editor option lists for the ideas table. Rendering is cheap: no option lists per cell (D-08).
import type { ReactNode } from 'react';
import {
  allowedTargets, homeView, prioValue, SOURCE_LABEL, statusKeyOf, statusLabel, TYPE_LABEL, IDEA_TYPES, VIEW_LABEL, type View,
} from '@/modules/fh/domain';
import type { IdeaRow } from '@/modules/fh/rows';
import type { Lookups } from '../_lib/data';
import { Chip, money, shortDate, StatusPill } from './ui';

export interface Option { value: string | null; label: string; depth?: number }

const featureLabel = (lk: Lookups | undefined, id: string | null) => (id ? lk?.features.find((f) => f.id === id)?.name ?? 'Deleted Feature' : '');

export function Cell({ row, col, lookups, view }: { row: IdeaRow; col: string; lookups?: Lookups; view: View }): ReactNode {
  switch (col) {
    case 'number': return <span className="tabular-nums text-[var(--muted)]">#{row.number}</span>;
    case 'title': {
      const moved = homeView(row);
      const held = (view === 'triage' || view === 'backlog') && moved !== view; // FH-109
      return (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium" title={row.title}>{row.title}</span>
          {held && <span className="shrink-0 rounded bg-[var(--hover)] px-1 text-xs text-[var(--muted)]">moved to {VIEW_LABEL[moved]}</span>}
        </span>
      );
    }
    case 'triage': return (
      <span className="flex gap-1 overflow-hidden">
        {row.unreviewed && <Chip>Unreviewed</Chip>}
        {row.companyMissing && <Chip>Company missing</Chip>}
        {row.topMatch && <Chip>Duplicate? {Math.round(row.topMatch.score * 100)}%</Chip>}
      </span>
    );
    case 'source': return <span className="flex gap-1 overflow-hidden">{(row.sources.length ? row.sources : ['MANUAL']).map((s) => <Chip key={s}>{SOURCE_LABEL[s as keyof typeof SOURCE_LABEL] ?? s}</Chip>)}</span>;
    case 'status': return <StatusPill status={statusKeyOf(row)} />;
    case 'type': return TYPE_LABEL[row.ideaType];
    case 'owner': return row.ownerId ? lookups?.owners.find((o) => o.id === row.ownerId)?.name ?? 'Former user' : <span className="text-[var(--muted)]">Unassigned</span>;
    case 'feature': return <span className="truncate" title={featureLabel(lookups, row.featureId)}>{featureLabel(lookups, row.featureId)}</span>;
    case 'milestone': return row.milestoneId ? lookups?.milestones.find((m) => m.id === row.milestoneId)?.name ?? '' : '';
    case 'companies': return <span className="truncate" title={row.companies.map((c) => c.name).join(', ')}>{row.companies.map((c) => c.name).join(', ')}</span>;
    case 'journeys': return <span className="truncate" title="Set by Journey Boards sync">{row.journeyIds.map((id) => lookups?.journeys.find((j) => j.id === id)?.name).filter(Boolean).join(', ')}</span>;
    case 'themes': return (
      <span className="flex gap-1 overflow-hidden">
        {row.themeIds.map((id) => { const t = lookups?.themes.find((x) => x.id === id); return t ? <Chip key={id} colour={t.colour}>{t.name}</Chip> : null; })}
      </span>
    );
    case 'strategicValue': case 'revenueImpact': case 'customerExperience': case 'riskScore': case 'effortScore': case 'estimateDays':
      return <span className="tabular-nums">{row[col] ?? ''}</span>;
    case 'prio': { const p = prioValue(row); return <span className="tabular-nums">{p === null ? '' : p.toFixed(2)}</span>; }
    case 'users': return <span className="tabular-nums">{row.userCount}</span>;
    case 'companyCount': return <span className="tabular-nums">{row.companyCount}</span>;
    case 'arr': return <span className="tabular-nums">{money(row.arr, lookups?.settings.currency ?? 'EUR')}</span>;
    case 'insights': return <span className="tabular-nums">{row.insightCount}</span>;
    case 'votes': return <span className="tabular-nums" title={`${row.voteTotal} votes in total from ${row.distinctVoters} distinct voters`}>{row.distinctVoters}</span>;
    case 'startDate': return shortDate(row.startDate);
    case 'dueDate': return shortDate(row.dueDate);
    case 'committed': return row.isCommitted ? 'Yes' : 'No';
    case 'dealbreaker': return row.isDealbreaker ? 'Yes' : 'No';
    case 'createdAt': return shortDate(row.createdAt);
    case 'updatedAt': return shortDate(row.updatedAt);
    default: return null;
  }
}

/** Options for a single-choice editor. The idea's own workflow only offers allowed targets (FH-302). */
export function optionsFor(col: string, row: IdeaRow, lookups: Lookups): Option[] {
  switch (col) {
    case 'status': { const k = statusKeyOf(row); return k ? allowedTargets(k).map((s) => ({ value: s, label: statusLabel(s) })) : []; }
    case 'type': return IDEA_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }));
    case 'owner': return [{ value: null, label: 'Unassigned' }, ...lookups.owners.map((o) => ({ value: o.id, label: o.name }))];
    case 'milestone': return [{ value: null, label: 'No milestone' }, ...lookups.milestones.map((m) => ({ value: m.id, label: `${m.name} (${shortDate(m.date)})` }))];
    case 'feature': return [{ value: null, label: 'No Feature' }, ...orderedFeatures(lookups).map((f) => ({ value: f.id, label: f.name, depth: f.depth }))];
    case 'themes': return lookups.themes.map((t) => ({ value: t.id, label: t.name }));
    default: return [];
  }
}

export function orderedFeatures(lookups: Lookups) {
  const byParent = new Map<string | null, Lookups['features']>();
  for (const f of lookups.features) byParent.set(f.parentId, [...(byParent.get(f.parentId) ?? []), f]);
  const out: Lookups['features'] = [];
  const walk = (p: string | null) => (byParent.get(p) ?? []).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)).forEach((f) => { out.push(f); walk(f.id); });
  walk(null);
  return out;
}

export function currentValue(col: string, row: IdeaRow): string | null {
  switch (col) {
    case 'status': return statusKeyOf(row);
    case 'type': return row.ideaType;
    case 'owner': return row.ownerId;
    case 'feature': return row.featureId;
    case 'milestone': return row.milestoneId;
    default: return null;
  }
}
