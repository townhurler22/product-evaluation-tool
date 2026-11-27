'use client';

// Idea panel (FH-211–225, §4.6). Header, details and impact draw from the cached row at once; the summary and lazy
// sections load after first paint, each with its own cache key. A just-created idea skips evidence and comments.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  allowedTargets, IDEA_TYPES, prioValue, SOURCE_LABEL, statusKeyOf, statusLabel, TYPE_LABEL, INSIGHT_PRIORITIES, type View,
} from '@/modules/fh/domain';
import type { IdeaRow } from '@/modules/fh/rows';
import { CALL_TYPE_LABEL, type IntakeMeta } from '@/modules/fh/intake-meta';
import { api, ApiFailure } from '../_lib/api';
import { keys, removeFromLists, type Lookups } from '../_lib/data';
import { AFFECTS_LOOKUPS, saveField, type EditValue } from '../_lib/edit';
import { useLiveChannels } from '../_lib/live';
import { rowStore, useRow } from '../_lib/rows';
import { orderedFeatures } from './cells';
import { CompanyPick } from './cell-editor';
import PublishDialog from './publish-dialog';
import { btn, btnPrimary, Chip, Dialog, input, Markdown, money, shortDate, StatusPill } from './ui';

interface Summary {
  id: string; number: number; title: string; description: string | null; publicSummary: string | null;
  themes: { id: string; name: string; colour: string | null }[]; journeys: { id: string; name: string }[];
  companies: { id: string; name: string; arr: string | null }[]; people: { id: string; name: string; companyName: string | null }[];
  posts: { id: string; title: string; voteCount: number }[]; createdByName: string | null;
}
interface Insight { id: string; value: string; source: string; priority: string; url: string | null; createdAt: string; companyName: string | null; personName: string | null; verifiedBy: string | null; staffName: string | null; meta: IntakeMeta | null }
interface Activity { id: string; kind: 'status' | 'field'; field: string | null; from: string | null; to: string | null; comment: string | null; at: string; actor: string | null }
interface Comment { id: string; body: string | null; authorId: string | null; authorName: string | null; createdAt: string; editedAt: string | null; deleted: boolean }

const FIELD_LABEL: Record<string, string> = {
  title: 'Title', owner: 'Owner', feature: 'Feature', milestone: 'Milestone', startDate: 'Start date', dueDate: 'Due date',
  estimateDays: 'Estimate (days)', strategicValue: 'Strategic value', revenueImpact: 'Revenue impact', customerExperience: 'Customer experience',
  riskScore: 'Risk', effortScore: 'Effort', isDealbreaker: 'Dealbreaker', isCommitted: 'Committed', themes: 'Themes', type: 'Type', reviewed: 'Reviewed',
};

/** FH-220 phrasing. */
export function activityText(a: Activity): string {
  if (a.kind === 'status') {
    const from = a.from ? statusLabel(a.from as never) : 'None';
    return `Status: ${from} → ${statusLabel(a.to as never)}${a.comment ? `. ${a.comment}` : ''}`;
  }
  if (a.field === 'merge') return a.to ?? 'Merged';
  if (a.field === 'created') return a.to ?? 'Created';
  if (a.field === 'description') return 'Description edited';
  if (a.field === 'publicSummary') return 'Public summary edited';
  const label = FIELD_LABEL[a.field ?? ''] ?? a.field ?? 'Field';
  if (a.from === null) return `${label} set to ${a.to}`;
  if (a.to === null) return `${label} cleared (was ${a.from})`;
  return `${label}: ${a.from} → ${a.to}`;
}

function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(() => typeof window !== 'undefined' && typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setSeen(true); });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

export default function IdeaPanel({ id, lookups, isAdmin, onClose, onOpen, onNavigate, onDeleted }: {
  id: string; lookups: Lookups; isAdmin: boolean; view: View; onClose: () => void; onOpen: (id: string) => void;
  onNavigate: (dir: 1 | -1) => void; onDeleted: (ids: string[]) => void;
}) {
  const qc = useQueryClient();
  const row = useRow(id);
  const [error, setError] = useState('');
  const [merging, setMerging] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // Deep link (PERF-12): the row is not cached, so load it alongside the summary.
  useEffect(() => {
    if (!rowStore.get(id)) api<{ rows: IdeaRow[] }>(`/api/fh/ideas?ids=${id}`).then((r) => rowStore.upsert(r.rows)).catch(() => {});
  }, [id]);

  const summary = useQuery({
    queryKey: keys.detail('summary', id), staleTime: 60_000, retry: false,
    queryFn: () => api<{ summary: Summary }>(`/api/fh/ideas/${id}`).then((r) => r.summary),
  });
  const gone = summary.error instanceof ApiFailure && summary.error.status === 410 ? summary.error : null;
  const hasEvidence = !!row && (row.insightCount > 0 || row.userCount > 0 || row.companyCount > 0);
  const evidence = useQuery({
    queryKey: keys.detail('evidence', id), staleTime: 60_000, enabled: hasEvidence && !gone,
    queryFn: () => api<{ insights: Insight[]; countedPeople: { id: string; name: string; companyName: string | null; reasons: string[] }[] }>(`/api/fh/ideas/${id}/evidence`),
  });
  const isOpenStatus = row ? ['IDEA_OPEN', 'BUG_OPEN'].includes(statusKeyOf(row) ?? '') : false;
  const matches = useQuery({
    queryKey: keys.detail('matches', id), staleTime: 60_000, enabled: (isOpenStatus || !!row?.unreviewed) && !gone,
    queryFn: () => api<{ matches: { id: string; number: number; title: string; score: number }[] }>(`/api/fh/ideas/${id}/matches`).then((r) => r.matches),
  });

  // fh.idea.<id>: refetch only the sections named in idea.detail.changed (FH-225).
  useLiveChannels([`fh.idea.${id}`], useCallback((e) => {
    if (e.event === 'idea.detail.changed') for (const s of e.payload.sections) qc.invalidateQueries({ queryKey: keys.detail(s, id) });
  }, [qc, id]));

  // Keyboard: Esc closes; J/K move through the current list (FH-211).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable], [role="dialog"]')) return;
      if (e.key === 'Escape') onClose();
      if (e.key === 'j' || e.key === 'J') onNavigate(1);
      if (e.key === 'k' || e.key === 'K') onNavigate(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onNavigate]);

  const save = async (col: string, value: EditValue) => {
    const r = await saveField(id, col, value);
    if (!r.ok) setError(r.message ?? 'Could not save.'); else setError('');
    if (r.ok && ['title', 'description', 'publicSummary', 'themes', 'companies'].includes(col)) qc.invalidateQueries({ queryKey: keys.detail('summary', id) });
    if (r.ok) qc.invalidateQueries({ queryKey: keys.detail('activity', id) });
    if (r.ok && AFFECTS_LOOKUPS.has(col)) qc.invalidateQueries({ queryKey: keys.lookups });
    return r.ok;
  };

  async function del() {
    if (!window.confirm('Delete this idea? Its insights, themes, status history, activity and comments are deleted. Forum posts are kept.')) return;
    try { await api('/api/fh/ideas/delete', { method: 'POST', body: { ids: [id] } }); onDeleted([id]); }
    catch (e) { setError((e as Error).message); }
  }

  const shell = (children: ReactNode) => (
    <aside aria-label="Idea" className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-[var(--bg)] xl:static xl:z-auto xl:w-[34rem] xl:shrink-0 xl:border-l xl:border-[var(--border)]">
      {children}
    </aside>
  );

  if (gone) {
    const into = gone.details?.mergedIntoId as string;
    const info = gone.details?.mergedInto as { number: number; title: string } | undefined;
    return shell(
      <div className="p-4">
        <div className="flex justify-end"><button className={btn} onClick={onClose}>Close</button></div>
        {/* FH-223 */}
        <p className="mt-4">This idea was merged into <button className="underline" onClick={() => onOpen(into)}>#{info?.number} {info?.title}</button>.</p>
      </div>,
    );
  }
  if (!row) return shell(<p className="p-4" role="status">{summary.isError ? 'This idea could not be found.' : 'Loading…'}</p>);

  const key = statusKeyOf(row);
  const prio = prioValue(row);
  const currency = lookups.settings.currency;
  const copyLink = async () => {
    const url = `${window.location.origin}/fh/ideas?idea=${id}`;
    try { await navigator.clipboard.writeText(url); setError('Link copied.'); } catch { setError(url); }
  };

  return shell(
    <>
      <header className="flex flex-wrap items-start gap-2 border-b border-[var(--border)] p-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-[var(--muted)]">#{row.number} · {TYPE_LABEL[row.ideaType]} · <StatusPill status={key} /></p>
          <EditableText label="Title" value={row.title} max={200} disabled={!isAdmin} onSave={(v) => save('title', v)}
            render={(v) => <h2 className="text-lg font-semibold break-words">{v}</h2>} />
        </div>
        <div className="flex flex-wrap gap-1">
          <button className={btn} onClick={copyLink}>Copy link</button>
          {isAdmin && <button className={btn} onClick={() => setMerging(true)}>Merge…</button>}
          {isAdmin && <button className={`${btn} text-[var(--danger)]`} onClick={del}>Delete</button>}
          <button className={btn} onClick={onClose} aria-label="Close the idea">Close</button>
        </div>
        {error && <p role="status" className="w-full text-sm">{error}</p>}
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto sm:grid-cols-[1fr_13rem]">
        <div className="min-w-0 space-y-5 p-3">
          <Section title="Description">
            <EditableText label="Description" multiline value={summary.data?.description ?? ''} max={10_000} disabled={!isAdmin || !summary.data}
              version={row.version} onSave={(v) => save('description', v || null)}
              render={(v) => (v ? <Markdown text={v} /> : <p className="text-sm text-[var(--muted)]">{summary.isLoading ? 'Loading…' : 'No description.'}</p>)} />
          </Section>

          {(isOpenStatus || row.unreviewed || row.companyMissing || row.onForum) && (
            <Section title="Triage">
              <div className="flex flex-wrap gap-1">
                {(row.sources.length ? row.sources : ['MANUAL']).map((s) => <Chip key={s}>{SOURCE_LABEL[s as keyof typeof SOURCE_LABEL] ?? s}</Chip>)}
                {row.unreviewed && <Chip>Unreviewed</Chip>}
                {row.companyMissing && <Chip>Company missing</Chip>}
                {row.onForum && <Chip>On the forum</Chip>}
              </div>
              {isAdmin && row.unreviewed && (
                <button className={`${btn} mt-2`} onClick={async () => {
                  const r = await api<{ rows: IdeaRow[] }>('/api/fh/ideas/bulk/accept', { method: 'POST', body: { ids: [id] } });
                  rowStore.upsert(r.rows);
                }}>Accept</button>
              )}
              {isAdmin && (() => {
                // FH-213: disabled with the reason for a Question or an idea already on a forum.
                const why = row.ideaType === 'QUESTION' ? 'Questions cannot be published.' : row.onForum ? 'Already on a forum.' : null;
                return (
                  <div className="mt-2">
                    <button className={btn} disabled={!!why} aria-describedby={why ? `pub-why-${id}` : undefined} onClick={() => setPublishing(true)}>Publish to forum…</button>
                    {why && <span id={`pub-why-${id}`} className="ml-2 text-xs text-[var(--muted)]">{why}</span>}
                  </div>
                );
              })()}
              {publishing && <PublishDialog ids={[id]} onClose={() => setPublishing(false)} onDone={(m) => setError(m)} />}
              {matches.data && matches.data.length > 0 && (
                <div className="mt-2">
                  <h4 className="text-sm font-medium">Possible duplicates</h4>
                  <ul className="mt-1 space-y-1">
                    {matches.data.map((m) => <MatchRow key={m.id} m={m} isAdmin={isAdmin} sourceNumber={row.number} onOpen={onOpen} onMerged={(target) => {
                      rowStore.upsert([target]); removeFromLists(qc, [id]); onOpen(target.id);
                    }} sourceId={id} />)}
                  </ul>
                </div>
              )}
            </Section>
          )}

          <Section title={`Insights (${row.insightCount})`}>
            {isAdmin && <AddInsight ideaId={id} onAdded={() => { qc.invalidateQueries({ queryKey: keys.detail('evidence', id) }); qc.invalidateQueries({ queryKey: keys.detail('summary', id) }); }} />}
            {evidence.isLoading && hasEvidence && <p className="text-sm text-[var(--muted)]">Loading…</p>}
            <ul className="mt-2 space-y-2">
              {evidence.data?.insights.map((i) => (
                <li key={i.id} className="rounded-md border border-[var(--border)] p-2 text-sm">
                  {i.value === summary.data?.description ? <p className="italic text-[var(--muted)]">Same as the description.</p> : <p className="whitespace-pre-wrap break-words">{i.value}</p>}
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {[i.companyName, i.personName ? `${i.personName}${i.verifiedBy ? ` (Verified by ${i.verifiedBy.replace(/^ingest:/, '')})` : ''}` : i.staffName ?? (i.meta?.requesterName ? `${i.meta.requesterName} (not on file)` : null),
                      `${i.priority.charAt(0)}${i.priority.slice(1).toLowerCase()} priority`, SOURCE_LABEL[i.source as keyof typeof SOURCE_LABEL] ?? i.source, shortDate(i.createdAt)].filter(Boolean).join(' · ')}
                    {i.url && <> · <a href={i.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="underline">{i.meta?.call ? 'Call record' : 'Link'}</a></>}
                  </p>
                  <IntakeEvidence meta={i.meta} />
                  {isAdmin && <button className="mt-1 text-xs text-[var(--danger)] underline" onClick={async () => {
                    if (!window.confirm('Delete this insight?')) return;
                    const r = await api<{ row: IdeaRow | null }>(`/api/fh/insights/${i.id}`, { method: 'DELETE' });
                    if (r.row) rowStore.upsert([r.row]);
                    qc.invalidateQueries({ queryKey: keys.detail('evidence', id) });
                  }}>Delete insight</button>}
                </li>
              ))}
            </ul>
          </Section>

          {(row.sources.includes('SUPPORT_BUTTON') || row.sources.includes('FORUM')) && <Screenshots ideaId={id} />}

          <Section title="Themes">
            <ThemeEditor row={row} lookups={lookups} isAdmin={isAdmin} onSave={(ids) => save('themes', ids)} />
          </Section>

          <Section title="Journeys">
            <div className="flex flex-wrap gap-1">
              {row.journeyIds.length === 0 && <p className="text-sm text-[var(--muted)]">None yet.</p>}
              {row.journeyIds.map((jid) => { const j = lookups.journeys.find((x) => x.id === jid); return j ? <span key={jid} title="Set by Journey Boards sync"><Chip>{j.name}</Chip></span> : null; })}
            </div>
          </Section>

          <Section title="Companies who asked">
            <CompaniesEditor row={row} isAdmin={isAdmin} onSave={(ids) => save('companies', ids)} />
          </Section>
          <Section title="People who asked">
            <div className="flex flex-wrap gap-1">{summary.data?.people.map((p) => <Chip key={p.id}>{p.name}{p.companyName ? ` (${p.companyName})` : ''}</Chip>)}</div>
            {evidence.data && evidence.data.countedPeople.length > 0 && (
              <details className="mt-2 text-sm"><summary className="cursor-pointer">Counted people ({evidence.data.countedPeople.length})</summary>
                <ul className="mt-1 space-y-0.5">{evidence.data.countedPeople.map((p) => <li key={p.id}>{p.name}{p.companyName ? `, ${p.companyName}` : ''} <span className="text-xs text-[var(--muted)]">({p.reasons.join(', ')})</span></li>)}</ul>
              </details>
            )}
          </Section>

          {isAdmin && <Comments ideaId={id} userId={lookups.access.userId} skip={row.version === 1} />}
          <ActivitySection ideaId={id} version={row.version} />
        </div>

        <div className="space-y-4 border-t border-[var(--border)] p-3 sm:border-l sm:border-t-0">
          <Section title="Impact">
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Tile label="Users" value={row.userCount} />
              <Tile label="Companies" value={row.companyCount} />
              <Tile label="ARR" value={money(row.arr, currency)} />
              <Tile label="Insights" value={row.insightCount} />
              {/* D-35: vote total and distinct voters are separate, labelled numbers (team votes count in the total). */}
              <Tile label="Distinct voters" value={row.distinctVoters} />
              <Tile label="Vote total" value={row.voteTotal} />
            </dl>
          </Section>
          <Section title="Details">
            <div className="space-y-2 text-sm">
              <Field label="Status">{isAdmin && key ? (
                <select aria-label="Status" className={`${input} w-full`} value={key} onChange={(e) => void save('status', e.target.value)}>
                  {allowedTargets(key).map((k) => <option key={k} value={k}>{statusLabel(k)}</option>)}
                </select>) : <StatusPill status={key} />}</Field>
              <Field label="Type">{isAdmin ? (
                <select aria-label="Type" className={`${input} w-full`} value={row.ideaType} onChange={(e) => void save('type', e.target.value)}>
                  {IDEA_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </select>) : TYPE_LABEL[row.ideaType]}</Field>
              <SelectField label="Milestone" disabled={!isAdmin} value={row.milestoneId} onChange={(v) => save('milestone', v)}
                options={[{ value: '', label: 'None' }, ...lookups.milestones.map((m) => ({ value: m.id, label: m.name }))]} />
              <SelectField label="Owner" disabled={!isAdmin} value={row.ownerId} onChange={(v) => save('owner', v)}
                options={[{ value: '', label: 'Unassigned' }, ...lookups.owners.map((o) => ({ value: o.id, label: o.name }))]} />
              <SelectField label="Feature" disabled={!isAdmin} value={row.featureId} onChange={(v) => save('feature', v)}
                options={[{ value: '', label: 'No Feature' }, ...orderedFeatures(lookups).map((f) => ({ value: f.id, label: `${'  '.repeat(f.depth)}${f.name}` }))]} />
              <DateField label="Start date" disabled={!isAdmin} value={row.startDate} onChange={(v) => save('startDate', v)} />
              <DateField label="Due date" disabled={!isAdmin} value={row.dueDate} onChange={(v) => save('dueDate', v)} />
              <NumberField label="Estimate (days)" min={0} max={3650} disabled={!isAdmin} value={row.estimateDays} onChange={(v) => save('estimateDays', v)} />
              <Field label="Prio-Value"><span className="tabular-nums">{prio === null ? 'Score all five to see it' : prio.toFixed(2)}</span></Field>
              {(['strategicValue', 'revenueImpact', 'customerExperience', 'riskScore', 'effortScore'] as const).map((s) => (
                <NumberField key={s} label={FIELD_LABEL[s]} min={1} max={10} disabled={!isAdmin} value={row[s]} onChange={(v) => save(s, v)} />
              ))}
              <Field label="Committed">
                <label className="flex items-center gap-2" title={isOpenStatus ? 'An idea in Open cannot be committed. Triage it first.' : undefined}>
                  <input type="checkbox" disabled={!isAdmin || isOpenStatus} checked={row.isCommitted} onChange={(e) => void save('committed', e.target.checked)} /> {row.isCommitted ? 'Yes' : 'No'}
                </label>
              </Field>
              <Field label="Dealbreaker">
                <label className="flex items-center gap-2"><input type="checkbox" disabled={!isAdmin} checked={row.isDealbreaker} onChange={(e) => void save('dealbreaker', e.target.checked)} /> {row.isDealbreaker ? 'Yes' : 'No'}</label>
              </Field>
              <Field label="Public summary">
                <EditableText label="Public summary" multiline value={summary.data?.publicSummary ?? ''} max={5_000} disabled={!isAdmin || !summary.data}
                  onSave={(v) => save('publicSummary', v || null)} render={(v) => <p className="whitespace-pre-wrap text-sm">{v || <span className="text-[var(--muted)]">None</span>}</p>} />
              </Field>
              <Field label="Mapped on boards"><p className="text-xs text-[var(--muted)]">Shown once Journey Boards maps Features (P5).</p></Field>
            </div>
          </Section>
        </div>
      </div>
      {merging && <MergeDialog sourceId={id} sourceNumber={row.number} onClose={() => setMerging(false)} onMerged={(target) => {
        setMerging(false); rowStore.upsert([target]); removeFromLists(qc, [id]); onOpen(target.id);
      }} />}
    </>,
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section><h3 className="mb-1 text-sm font-semibold">{title}</h3>{children}</section>;
}
function Tile({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return <div className="rounded-md border border-[var(--border)] p-2" title={title}><dt className="text-xs text-[var(--muted)]">{label}</dt><dd className="text-base font-semibold tabular-nums">{value}</dd></div>;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><div className="text-xs text-[var(--muted)]">{label}</div>{children}</div>;
}
function SelectField({ label, value, options, onChange, disabled }: { label: string; value: string | null; options: { value: string; label: string }[]; onChange: (v: string | null) => void; disabled: boolean }) {
  return <label className="block"><span className="text-xs text-[var(--muted)]">{label}</span>
    <select className={`${input} w-full`} disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select></label>;
}
function DateField({ label, value, onChange, disabled }: { label: string; value: string | null; onChange: (v: string | null) => void; disabled: boolean }) {
  return <label className="block"><span className="text-xs text-[var(--muted)]">{label}</span>
    <input type="date" className={`${input} w-full`} disabled={disabled} defaultValue={value ?? ''} key={value ?? ''}
      onBlur={(e) => { const v = e.target.value || null; if (v !== value) onChange(v); }} /></label>;
}
function NumberField({ label, value, onChange, min, max, disabled }: { label: string; value: number | null; onChange: (v: number | null) => void; min: number; max: number; disabled: boolean }) {
  return <label className="block"><span className="text-xs text-[var(--muted)]">{label}</span>
    <input type="number" min={min} max={max} className={`${input} w-full`} disabled={disabled} defaultValue={value ?? ''} key={value ?? 'none'}
      onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== value) onChange(v); }} /></label>;
}

/** Inline text edit. If someone else changes the idea mid-edit, the user's text is kept and a notice offers a reload (FH-225). */
function EditableText({ label, value, max, multiline, disabled, onSave, render, version }: {
  label: string; value: string; max: number; multiline?: boolean; disabled: boolean; version?: number;
  onSave: (v: string) => Promise<boolean>; render: (v: string) => ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [startVersion, setStartVersion] = useState(version);
  if (!editing) {
    return (
      <div className="group">
        {render(value)}
        {!disabled && <button className="text-xs underline opacity-80" onClick={() => { setDraft(value); setStartVersion(version); setEditing(true); }}>Edit {label.toLowerCase()}</button>}
      </div>
    );
  }
  const changedElsewhere = version !== undefined && startVersion !== undefined && version !== startVersion;
  const Tag = multiline ? 'textarea' : 'input';
  return (
    <form onSubmit={async (e) => { e.preventDefault(); if (await onSave(draft)) setEditing(false); }} className="space-y-1">
      <Tag aria-label={label} className={`${input} w-full`} value={draft} maxLength={max} rows={multiline ? 6 : undefined} autoFocus
        onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value)}
        onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); } }} />
      {changedElsewhere && <p className="text-xs text-[var(--warn)]">Changed by someone else. <button type="button" className="underline" onClick={() => { setDraft(value); setStartVersion(version); }}>Reload field</button></p>}
      <div className="flex gap-2"><button type="submit" className={btnPrimary}>Save</button><button type="button" className={btn} onClick={() => setEditing(false)}>Cancel</button></div>
    </form>
  );
}

function ThemeEditor({ row, lookups, isAdmin, onSave }: { row: IdeaRow; lookups: Lookups; isAdmin: boolean; onSave: (ids: string[]) => Promise<boolean> }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [colour, setColour] = useState('#6366f1');
  const [err, setErr] = useState('');
  const others = lookups.themes.filter((t) => !row.themeIds.includes(t.id));
  return (
    <div>
      <div className="flex flex-wrap gap-1">
        {row.themeIds.length === 0 && <p className="text-sm text-[var(--muted)]">No themes.</p>}
        {row.themeIds.map((tid) => { const t = lookups.themes.find((x) => x.id === tid); return t ? (
          <Chip key={tid} colour={t.colour} removeLabel={`Remove theme ${t.name}`} onRemove={isAdmin ? () => void onSave(row.themeIds.filter((x) => x !== tid)) : undefined}>{t.name}</Chip>) : null; })}
      </div>
      {isAdmin && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {others.length > 0 && (
            <select aria-label="Add a theme" className={input} value="" onChange={(e) => { if (e.target.value) void onSave([...row.themeIds, e.target.value]); }}>
              <option value="">Add a theme…</option>
              {others.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <button className="text-xs underline" onClick={() => setAdding((a) => !a)}>New theme</button>
        </div>
      )}
      {adding && (
        <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api<{ theme: { id: string } }>('/api/fh/themes', { method: 'POST', body: { name: newName, colour } });
            await qc.invalidateQueries({ queryKey: keys.lookups });
            await onSave([...row.themeIds, r.theme.id]);
            setAdding(false); setNewName(''); setErr('');
          } catch (x) { setErr((x as Error).message); }
        }}>
          <input aria-label="Theme name" className={input} value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} required aria-describedby={err ? 'theme-err' : undefined} />
          <input aria-label="Theme colour" type="color" value={colour} onChange={(e) => setColour(e.target.value)} className="h-8 w-10" />
          <button type="submit" className={btn}>Create</button>
          {err && <p id="theme-err" role="alert" className="w-full text-xs text-[var(--danger)]">{err}</p>}
        </form>
      )}
    </div>
  );
}

function CompaniesEditor({ row, isAdmin, onSave }: { row: IdeaRow; isAdmin: boolean; onSave: (ids: string[]) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  return (
    <div>
      <div className="flex flex-wrap gap-1">
        {row.companies.length === 0 && <p className="text-sm text-[var(--muted)]">None yet.</p>}
        {row.companies.map((c) => <Chip key={c.id}>{c.name}</Chip>)}
      </div>
      {isAdmin && !editing && <button className="mt-1 text-xs underline" onClick={() => setEditing(true)}>Change companies</button>}
      {editing && <div className="mt-2 rounded-md border border-[var(--border)]"><CompanyPick initial={row.companies} onCancel={() => setEditing(false)} onCommit={async (ids) => { if (await onSave(ids)) setEditing(false); }} /></div>}
    </div>
  );
}

function AddInsight({ ideaId, onAdded }: { ideaId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [priority, setPriority] = useState('MEDIUM');
  const [url, setUrl] = useState('');
  const [company, setCompany] = useState<{ id: string; name: string } | null>(null);
  const [personQ, setPersonQ] = useState('');
  const [people, setPeople] = useState<{ id: string; name: string; companyName: string | null }[]>([]);
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null);
  useEffect(() => {
    if (!open || !personQ) return;
    const t = setTimeout(() => api<{ people: typeof people }>(`/api/fh/people?q=${encodeURIComponent(personQ)}`).then((r) => setPeople(r.people)).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [personQ, open]);
  if (!open) return <button className={btn} onClick={() => setOpen(true)}>Add insight</button>;
  return (
    <form className="space-y-2 rounded-md border border-[var(--border)] p-2 text-sm" onSubmit={async (e) => {
      e.preventDefault();
      try {
        const r = await api<{ row: IdeaRow }>(`/api/fh/ideas/${ideaId}/insights`, { method: 'POST', body: { value, priority, url: url || null, companyId: company?.id ?? null, personId: person?.id ?? null } });
        rowStore.upsert([r.row]); // FH-224: the new roll-up arrives in the response
        setOpen(false); setValue(''); setUrl(''); setCompany(null); setPerson(null); setErr(null);
        onAdded();
      } catch (x) { setErr({ field: x instanceof ApiFailure ? String(x.details?.field ?? '') : undefined, message: (x as Error).message }); }
    }}>
      <label className="block">What the client said
        <textarea className={`${input} mt-1 w-full`} rows={3} maxLength={5000} required value={value} onChange={(e) => setValue(e.target.value)} aria-describedby={err?.field === 'value' ? 'ins-err' : undefined} />
      </label>
      <div className="flex flex-wrap gap-2">
        <span>Company: {company ? <Chip onRemove={() => setCompany(null)} removeLabel="Remove company">{company.name}</Chip> : <button type="button" className="underline" onClick={() => setPicking(true)}>Choose</button>}</span>
      </div>
      {picking && <div className="rounded-md border border-[var(--border)]"><CompanyPick max={1} initial={company ? [company] : []} onCancel={() => setPicking(false)} onCommit={(_ids, chosen) => { setCompany(chosen[0] ?? null); setPicking(false); }} /></div>}
      <label className="block">Person
        {person ? <span className="ml-2"><Chip onRemove={() => setPerson(null)} removeLabel="Remove person">{person.name}</Chip></span> : (
          <input className={`${input} mt-1 w-full`} placeholder="Search people by name or email" value={personQ} onChange={(e) => setPersonQ(e.target.value)} />
        )}
      </label>
      {!person && personQ && people.length > 0 && (
        <ul className="max-h-32 overflow-auto rounded border border-[var(--border)]">
          {people.map((p) => <li key={p.id}><button type="button" className="w-full px-2 py-1 text-left hover:bg-[var(--hover)]" onClick={() => { setPerson(p); setPersonQ(''); }}>{p.name}{p.companyName ? ` (${p.companyName})` : ''}</button></li>)}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label>Priority
          <select className={`${input} mt-1 w-full`} value={priority} onChange={(e) => setPriority(e.target.value)}>
            {INSIGHT_PRIORITIES.map((p) => <option key={p} value={p}>{p.charAt(0) + p.slice(1).toLowerCase()}</option>)}
          </select>
        </label>
        <label>Link
          <input className={`${input} mt-1 w-full`} type="url" maxLength={2000} value={url} onChange={(e) => setUrl(e.target.value)} aria-describedby={err?.field === 'url' ? 'ins-err' : undefined} />
        </label>
      </div>
      {err && <p id="ins-err" role="alert" className="text-[var(--danger)]">{err.message}</p>}
      <div className="flex gap-2"><button type="submit" className={btnPrimary}>Add insight</button><button type="button" className={btn} onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

function MatchRow({ m, isAdmin, sourceId, sourceNumber, onOpen, onMerged }: {
  m: { id: string; number: number; title: string; score: number }; isAdmin: boolean; sourceId: string; sourceNumber: number;
  onOpen: (id: string) => void; onMerged: (target: IdeaRow) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState('');
  return (
    <li className="text-sm">
      <button className="underline" onClick={() => onOpen(m.id)}>#{m.number} {m.title}</button> <span className="text-xs text-[var(--muted)]">{Math.round(m.score * 100)}%</span>
      {isAdmin && !confirm && <button className="ml-2 text-xs underline" onClick={() => setConfirm(true)}>Merge into this</button>}
      {confirm && (
        // FH-407: two-step confirm naming the direction.
        <span className="ml-2 text-xs">Merge #{sourceNumber} into #{m.number}? This cannot be undone.
          <button className="ml-1 underline" onClick={async () => {
            try { const r = await api<{ target: IdeaRow }>(`/api/fh/ideas/${sourceId}/merge`, { method: 'POST', body: { targetId: m.id } }); onMerged(r.target); }
            catch (e) { setErr((e as Error).message); }
          }}>Yes, merge</button>
          <button className="ml-1 underline" onClick={() => setConfirm(false)}>Cancel</button>
        </span>
      )}
      {err && <span role="alert" className="ml-2 text-xs text-[var(--danger)]">{err}</span>}
    </li>
  );
}

function MergeDialog({ sourceId, sourceNumber, onClose, onMerged }: { sourceId: string; sourceNumber: number; onClose: () => void; onMerged: (t: IdeaRow) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<IdeaRow[]>([]);
  const [target, setTarget] = useState<IdeaRow | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (q.trim().length < 2) return;
    const t = setTimeout(() => api<{ rows: IdeaRow[] }>(`/api/fh/ideas?spec=${encodeURIComponent(JSON.stringify({ search: q }))}`).then((r) => setResults(r.rows.filter((x) => x.id !== sourceId).slice(0, 20))).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q, sourceId]);
  return (
    <Dialog title={`Merge #${sourceNumber} into another idea`} onClose={onClose}>
      {!target ? (
        <>
          <input autoFocus className={`${input} w-full`} placeholder="Search by title" aria-label="Search ideas by title" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="mt-2 max-h-64 overflow-auto">
            {(q.trim().length < 2 ? [] : results).map((r) => <li key={r.id}><button className="w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-[var(--hover)]" onClick={() => setTarget(r)}>#{r.number} {r.title}</button></li>)}
          </ul>
        </>
      ) : (
        <div className="space-y-3 text-sm">
          <p>Merge #{sourceNumber} into #{target.number} {target.title}? Its evidence moves to #{target.number}, which keeps its own title, status and details. #{sourceNumber} becomes a read-only record. This cannot be undone.</p>
          <p className="text-xs text-[var(--muted)]">Vote totals can go down when the same person voted on both.</p>
          {err && <p role="alert" className="text-[var(--danger)]">{err}</p>}
          <div className="flex justify-end gap-2">
            <button className={btn} onClick={() => setTarget(null)}>Back</button>
            <button className={btnPrimary} onClick={async () => {
              try { const r = await api<{ target: IdeaRow }>(`/api/fh/ideas/${sourceId}/merge`, { method: 'POST', body: { targetId: target.id } }); onMerged(r.target); }
              catch (e) { setErr((e as Error).message); }
            }}>Merge</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Comments({ ideaId, userId, skip }: { ideaId: string; userId: string; skip: boolean }) {
  const qc = useQueryClient();
  const [ref, seen] = useInView<HTMLElement>();
  const q = useQuery({
    queryKey: keys.detail('comments', ideaId), enabled: seen && !skip, staleTime: 60_000,
    queryFn: () => api<{ comments: Comment[] }>(`/api/fh/ideas/${ideaId}/comments`).then((r) => r.comments),
  });
  const [body, setBody] = useState('');
  const [err, setErr] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: keys.detail('comments', ideaId) });
  const list = skip && !q.data ? [] : q.data;
  return (
    <section ref={ref}>
      <h3 className="mb-1 text-sm font-semibold">Comments</h3>
      <p className="mb-2 text-xs text-[var(--muted)]">Never shown on the public forum.</p>
      <ul className="space-y-2">
        {list?.map((c) => (
          <li key={c.id} className="text-sm">
            <p className="text-xs text-[var(--muted)]">{c.authorName ?? 'Former user'} · {new Date(c.createdAt).toLocaleString('en-GB')}{c.editedAt ? ' · edited' : ''}</p>
            {c.deleted ? <p className="italic text-[var(--muted)]">Comment deleted</p> : <p className="whitespace-pre-wrap break-words">{c.body}</p>}
            {!c.deleted && c.authorId === userId && (
              <span className="text-xs">
                <button className="underline" onClick={async () => { const n = window.prompt('Edit comment', c.body ?? ''); if (n) { await api(`/api/fh/comments/${c.id}`, { method: 'PATCH', body: { body: n } }).catch((e) => setErr(e.message)); refresh(); } }}>Edit</button>{' '}
                <button className="underline" onClick={async () => { if (window.confirm('Delete this comment?')) { await api(`/api/fh/comments/${c.id}`, { method: 'DELETE' }).catch((e) => setErr(e.message)); refresh(); } }}>Delete</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <form className="mt-2 space-y-1" onSubmit={async (e) => {
        e.preventDefault();
        try { await api(`/api/fh/ideas/${ideaId}/comments`, { method: 'POST', body: { body } }); setBody(''); setErr(''); refresh(); } catch (x) { setErr((x as Error).message); }
      }}>
        <textarea aria-label="New comment" className={`${input} w-full`} rows={2} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} required />
        {err && <p role="alert" className="text-xs text-[var(--danger)]">{err}</p>}
        <button type="submit" className={btn}>Add comment</button>
      </form>
    </section>
  );
}

function ActivitySection({ ideaId, version }: { ideaId: string; version: number }) {
  const [ref, seen] = useInView<HTMLElement>();
  const [more, setMore] = useState<Activity[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const q = useQuery({
    queryKey: [...keys.detail('activity', ideaId), version], enabled: seen, staleTime: 60_000,
    queryFn: async () => {
      const r = await api<{ items: Activity[]; nextBefore: string | null }>(`/api/fh/ideas/${ideaId}/activity`);
      setMore([]); setBefore(r.nextBefore);
      return r.items;
    },
  });
  return (
    <section ref={ref}>
      <h3 className="mb-1 text-sm font-semibold">Activity</h3>
      {q.isLoading && seen && <p className="text-sm text-[var(--muted)]">Loading…</p>}
      <ul className="space-y-1 text-sm">
        {[...(q.data ?? []), ...more].map((a) => (
          <li key={a.id}><span>{activityText(a)}</span> <span className="text-xs text-[var(--muted)]">{a.actor ? `${a.actor}, ` : ''}{new Date(a.at).toLocaleString('en-GB')}</span></li>
        ))}
      </ul>
      {before && <button className="mt-1 text-xs underline" onClick={async () => {
        const r = await api<{ items: Activity[]; nextBefore: string | null }>(`/api/fh/ideas/${ideaId}/activity?before=${encodeURIComponent(before)}`);
        setMore((m) => [...m, ...r.items]); setBefore(r.nextBefore);
      }}>Show more</button>}
    </section>
  );
}

/** FH-214: intake evidence from the insight's meta (read defensively on the server, ING-27). */
function IntakeEvidence({ meta }: { meta: IntakeMeta | null }) {
  if (!meta) return null;
  const c = meta.call, ctx = meta.context;
  return (
    <div className="mt-1 space-y-0.5 text-xs text-[var(--muted)]">
      {c && <p>{[CALL_TYPE_LABEL[c.type], c.title, c.date ? shortDate(c.date) : null, c.timeInCall ? `at ${c.timeInCall}` : null].filter(Boolean).join(' · ')}</p>}
      {meta.quoteVerified === false && <p className="font-semibold text-[var(--danger)]">Quote not found in transcript</p>}
      {ctx && (ctx.module || ctx.page || ctx.appVersion) && (
        <p>{[ctx.module && `Module: ${ctx.module}`, ctx.page && `Page: ${ctx.page}`, ctx.appVersion && `Version ${ctx.appVersion}`].filter(Boolean).join(' · ')}</p>
      )}
      {!!meta.attachments?.length && <p>{meta.attachments.length} screenshot{meta.attachments.length === 1 ? '' : 's'} (see Screenshots)</p>}
    </div>
  );
}

/** FH-218: screenshots load only when the section is expanded; thumbnails open full size in a dialog. */
function Screenshots({ ideaId }: { ideaId: string }) {
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<{ url: string; name: string | null } | null>(null);
  const images = useQuery({
    queryKey: keys.detail('images', ideaId), enabled: open, staleTime: 10 * 60_000, // signed URLs last 15 minutes
    queryFn: () => api<{ images: { id: string; url: string; name: string | null }[] }>(`/api/fh/ideas/${ideaId}/images`).then((r) => r.images),
  });
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">
        <button type="button" aria-expanded={open} className="underline-offset-2 hover:underline" onClick={() => setOpen((o) => !o)}>
          Screenshots{images.data ? ` (${images.data.length})` : ''} {open ? '▾' : '▸'}
        </button>
      </h3>
      {open && images.isLoading && <p className="text-sm text-[var(--muted)]">Loading…</p>}
      {open && images.isError && <p className="text-sm text-[var(--danger)]">Screenshots could not be loaded.</p>}
      {open && images.data?.length === 0 && <p className="text-sm text-[var(--muted)]">None.</p>}
      {open && !!images.data?.length && (
        <ul className="flex flex-wrap gap-2">
          {images.data.map((img) => (
            <li key={img.id}>
              <button type="button" className="block rounded border border-[var(--border)]" onClick={() => setViewing(img)} aria-label={`View ${img.name ?? 'screenshot'} full size`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt={img.name ?? 'Screenshot'} className="h-20 w-28 object-cover" loading="lazy" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {viewing && (
        <Dialog title={viewing.name ?? 'Screenshot'} onClose={() => setViewing(null)} wide>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={viewing.url} alt={viewing.name ?? 'Screenshot'} className="max-h-[75vh] w-full object-contain" />
        </Dialog>
      )}
    </section>
  );
}
