'use client';

// Bulk bar (FH-153–157). Requests go in chunks of the server cap, one after another, with progress; a failure part-way
// keeps what committed and says how far it got (D-33).
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { STATUS_KEYS, statusKeyOf, statusLabel, sameWorkflow, type StatusKey } from '@/modules/fh/domain';
import type { ViewSpecInput } from '@/modules/fh/columns';
import type { IdeaRow } from '@/modules/fh/rows';
import { api, downloadExport } from '../_lib/api';
import { keys, type Lookups } from '../_lib/data';
import { rowStore } from '../_lib/rows';
import { fmtCount, runChunks } from '../_lib/selection';
import PublishDialog from './publish-dialog';
import { btn, Dialog, input } from './ui';

type Action = 'accept' | 'status' | 'milestone' | 'themes' | 'delete' | 'publish';

export default function BulkBar({ ids, spec, columns, lookups, isAdmin, onClear, onDeleted, onMessage }: {
  ids: string[]; spec: ViewSpecInput; columns: string[]; lookups?: Lookups; isAdmin: boolean;
  onClear: () => void; onDeleted: (ids: string[]) => void; onMessage: (t: string) => void;
}) {
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<Action | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const rows = ids.map((id) => rowStore.get(id)).filter((r): r is IdeaRow => !!r);
  const unreviewed = rows.filter((r) => r.unreviewed).length;
  const keysSel = rows.map((r) => statusKeyOf(r)).filter((k): k is StatusKey => !!k);
  const oneWorkflow = keysSel.length === rows.length && keysSel.every((k) => sameWorkflow(k, keysSel[0]));

  async function run(verb: string, past: string, path: string, extra: Record<string, unknown>, onRows?: (r: { rows?: IdeaRow[] }) => void) {
    setDialog(null);
    const res = await runChunks(ids, async (chunk) => {
      const r = await api<{ rows?: IdeaRow[]; skipped?: unknown[]; deleted?: number }>(path, { method: 'POST', body: { ids: chunk, ...extra } });
      if (r.rows) rowStore.upsert(r.rows);
      onRows?.(r);
      return r;
    }, (p) => setProgress(`${verb} ${fmtCount(p.done)} of ${fmtCount(p.total)}…`));
    setProgress(null);
    const skipped = res.results.reduce((n, r) => n + (r.skipped?.length ?? 0), 0);
    if (res.error) onMessage(`${past} ${fmtCount(res.done)} of ${fmtCount(res.total)}, then stopped: ${res.error.message}`);
    else onMessage(`${past} ${fmtCount(res.done - skipped)} of ${fmtCount(res.total)}${skipped ? ` (${fmtCount(skipped)} skipped)` : ''}.`);
    qc.invalidateQueries({ queryKey: keys.lookups });
    return res;
  }

  return (
    <div role="region" aria-label="Bulk actions" className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm">
      <span className="font-medium">{fmtCount(ids.length)} selected</span>
      {isAdmin && (
        <>
          <button className={btn} disabled={!unreviewed} onClick={() => run('Accepting', 'Accepted', '/api/fh/ideas/bulk/accept', {})}>Accept ({fmtCount(unreviewed)})</button>
          <button className={btn} disabled={!oneWorkflow} title={oneWorkflow ? undefined : 'Select ideas from one workflow to set their status'} onClick={() => setDialog('status')}>Set status…</button>
          <button className={btn} onClick={() => setDialog('milestone')}>Milestone…</button>
          <button className={btn} onClick={() => setDialog('themes')}>Themes…</button>
          <button className={btn} onClick={() => setDialog('publish')}>Publish to forum…</button>
        </>
      )}
      <button className={btn} onClick={async () => {
        try { const n = await downloadExport({ viewSpec: spec, ids, columns }); onMessage(`Exported ${fmtCount(n)} ideas.`); } catch (e) { onMessage((e as Error).message); }
      }}>Export selected ({fmtCount(ids.length)})</button>
      {isAdmin && <button className={`${btn} text-[var(--danger)]`} onClick={() => setDialog('delete')}>Delete</button>}
      <button className={btn} onClick={onClear}>Clear selection</button>
      {progress && <span role="status" aria-live="polite">{progress}</span>}

      {dialog === 'status' && keysSel[0] && (
        <PickDialog title={`Set status on ${fmtCount(ids.length)} ideas`} label="Status" withComment
          options={STATUS_KEYS.filter((k) => sameWorkflow(k, keysSel[0])).map((k) => ({ value: k, label: statusLabel(k) }))}
          onClose={() => setDialog(null)} onPick={(v, comment) => run('Updating', 'Updated', '/api/fh/ideas/bulk/status', { status: v, comment: comment || null })} />
      )}
      {dialog === 'milestone' && lookups && (
        <PickDialog title={`Milestone for ${fmtCount(ids.length)} ideas`} label="Milestone"
          options={[{ value: '', label: 'Clear milestone' }, ...lookups.milestones.map((m) => ({ value: m.id, label: m.name }))]}
          onClose={() => setDialog(null)} onPick={(v) => run('Assigning', 'Assigned', '/api/fh/milestones/assign', { milestoneId: v || null })} />
      )}
      {dialog === 'themes' && lookups && (
        <PickDialog title={`Themes on ${fmtCount(ids.length)} ideas`} label="Theme" withAction
          options={lookups.themes.map((t) => ({ value: t.id, label: t.name }))}
          onClose={() => setDialog(null)} onPick={(v, _c, action) => run(action === 'remove' ? 'Removing' : 'Adding', action === 'remove' ? 'Removed from' : 'Added to', '/api/fh/ideas/bulk/themes', { themeId: v, action })} />
      )}
      {dialog === 'publish' && <PublishDialog ids={ids} onClose={() => setDialog(null)} onDone={onMessage} />}
      {dialog === 'delete' && (
        <Dialog title={`Delete ${fmtCount(ids.length)} ideas?`} onClose={() => setDialog(null)}>
          {/* FH-155 */}
          <p className="text-sm">Their insights, themes, status history, activity and comments are deleted. Forum posts are kept. This cannot be undone.</p>
          <div className="mt-4 flex justify-end gap-2">
            <button className={btn} onClick={() => setDialog(null)}>Cancel</button>
            <button className={`${btn} border-[var(--danger)] text-[var(--danger)]`} onClick={async () => {
              const deleted: string[] = [];
              const all = [...ids];
              const res = await run('Deleting', 'Deleted', '/api/fh/ideas/delete', {});
              // Chunks that committed are gone; remove exactly those from the lists.
              deleted.push(...all.slice(0, res.done));
              onDeleted(deleted);
              onClear();
            }}>Delete</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function PickDialog({ title, label, options, onPick, onClose, withComment, withAction }: {
  title: string; label: string; options: { value: string; label: string }[]; onClose: () => void;
  onPick: (v: string, comment?: string, action?: 'add' | 'remove') => void; withComment?: boolean; withAction?: boolean;
}) {
  const [v, setV] = useState(options[0]?.value ?? '');
  const [comment, setComment] = useState('');
  const [action, setAction] = useState<'add' | 'remove'>('add');
  return (
    <Dialog title={title} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onPick(v, comment, action); }}>
        {withAction && (
          <fieldset className="flex gap-4 text-sm"><legend className="sr-only">Add or remove</legend>
            <label><input type="radio" checked={action === 'add'} onChange={() => setAction('add')} /> Add</label>
            <label><input type="radio" checked={action === 'remove'} onChange={() => setAction('remove')} /> Remove</label>
          </fieldset>
        )}
        <label className="block text-sm">{label}
          <select className={`${input} mt-1 w-full`} value={v} onChange={(e) => setV(e.target.value)}>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {withComment && <label className="block text-sm">Comment (optional)<input className={`${input} mt-1 w-full`} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} /></label>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="submit" className={btn}>Apply</button>
        </div>
      </form>
    </Dialog>
  );
}
