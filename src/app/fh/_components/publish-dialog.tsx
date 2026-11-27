'use client';

// "Publish to forum…" (FH-411 to FH-413): preview with editable title and details per idea, refusals shown with
// their reason, then publish to the main forum. Used by the bulk bar and the idea panel.
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PUBLISH_MAX } from '@/modules/fh/forum-domain';
import type { IdeaRow } from '@/modules/fh/rows';
import { api, ApiFailure } from '../_lib/api';
import { keys } from '../_lib/data';
import { rowStore } from '../_lib/rows';
import { btn, btnPrimary, Dialog, input } from './ui';

type Item = { ideaId: string; title: string; details: string | null } | { ideaId: string; reason: string };
interface Preview { forum: { id: string; name: string }; items: Item[] }
interface Result { forum: { id: string; name: string }; published: { ideaId: string; postId: string }[]; skipped: { ideaId: string; reason: string }[] }

export default function PublishDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: (message: string) => void }) {
  const qc = useQueryClient();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [edits, setEdits] = useState<Record<string, { title: string; details: string }>>({});
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const tooMany = ids.length > PUBLISH_MAX;

  useEffect(() => {
    if (tooMany) return;
    api<Preview>('/api/fh/ideas/publish/preview', { method: 'POST', body: { ids } })
      .then((p) => {
        setPreview(p);
        setEdits(Object.fromEntries(p.items.filter((i): i is Extract<Item, { title: string }> => 'title' in i)
          .map((i) => [i.ideaId, { title: i.title, details: i.details ?? '' }])));
      })
      .catch((e) => setError({ message: (e as Error).message }));
  }, [ids, tooMany]);

  const ok = preview?.items.filter((i) => 'title' in i) ?? [];
  const title = (id: string) => rowStore.get(id)?.title ?? 'Idea';

  async function publish() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<Result>('/api/fh/ideas/publish', {
        method: 'POST',
        body: { forumId: preview.forum.id, items: ok.map((i) => ({ ideaId: i.ideaId, title: edits[i.ideaId].title, details: edits[i.ideaId].details || null })) },
      });
      // The changed rows arrive by live update; refresh what is loaded so "On the forum" shows at once.
      const rows = await api<{ rows: IdeaRow[] }>(`/api/fh/ideas?ids=${r.published.map((p) => p.ideaId).join(',')}`).catch(() => null);
      if (rows) rowStore.upsert(rows.rows);
      qc.invalidateQueries({ queryKey: keys.ideasAll });
      onDone(`Published ${r.published.length} to ${r.forum.name}${r.skipped.length ? `; ${r.skipped.length} skipped (${[...new Set(r.skipped.map((s) => s.reason))].join(' ')})` : ''}.`);
      onClose();
    } catch (e) {
      const f = e as ApiFailure;
      setError({ message: f.message, field: typeof f.details?.field === 'string' ? f.details.field : undefined });
    } finally { setBusy(false); }
  }

  return (
    <Dialog title={preview ? `Publish to ${preview.forum.name}` : 'Publish to forum'} onClose={onClose} wide>
      {tooMany && <p className="text-sm">Select at most {PUBLISH_MAX} ideas to publish at a time.</p>}
      {!tooMany && !preview && !error && <p role="status" className="text-sm text-[var(--muted)]">Preparing…</p>}
      {preview && (
        <div className="space-y-3">
          <p className="text-sm text-[var(--muted)]">Each post is published under the team, never the customer. It opens with one vote: the earliest requester on file, or yours if there is none. Edit the public wording below; the idea itself does not change.</p>
          <ol className="space-y-3">
            {preview.items.map((it, n) => (
              <li key={it.ideaId} className="rounded-md border border-[var(--border)] p-2">
                {'reason' in it ? (
                  <p className="text-sm"><span className="font-medium">{title(it.ideaId)}</span>: <span className="text-[var(--warn)]">{it.reason}</span></p>
                ) : (
                  <div className="space-y-2">
                    <label className="block text-sm font-medium">Public title
                      <input className={`${input} mt-1 w-full`} maxLength={200} required value={edits[it.ideaId]?.title ?? ''}
                        aria-invalid={error?.field === `items.${ok.indexOf(it)}.title` || undefined}
                        onChange={(e) => setEdits((x) => ({ ...x, [it.ideaId]: { ...x[it.ideaId], title: e.target.value } }))} />
                    </label>
                    <label className="block text-sm font-medium">Public details
                      <textarea className={`${input} mt-1 w-full`} rows={3} maxLength={5000} value={edits[it.ideaId]?.details ?? ''}
                        onChange={(e) => setEdits((x) => ({ ...x, [it.ideaId]: { ...x[it.ideaId], details: e.target.value } }))} />
                    </label>
                    <span className="sr-only">Item {n + 1}</span>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-[var(--danger)]">{error.message}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btn} onClick={onClose}>Cancel</button>
        {preview && <button type="button" className={btnPrimary} disabled={busy || !ok.length} onClick={publish}>{busy ? 'Publishing…' : `Publish ${ok.length}`}</button>}
      </div>
    </Dialog>
  );
}
