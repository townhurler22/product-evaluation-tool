'use client';

// New idea (FH-201): title, type, Feature (rail Feature preselected), description. The panel opens from the response.
import { useState } from 'react';
import { IDEA_TYPES, TYPE_LABEL } from '@/modules/fh/domain';
import type { IdeaRow } from '@/modules/fh/rows';
import { api, ApiFailure } from '../_lib/api';
import type { Lookups } from '../_lib/data';
import { orderedFeatures } from './cells';
import { btn, btnPrimary, Dialog, input } from './ui';

export default function CreateIdeaDialog({ lookups, defaultFeatureId, onClose, onCreated }: {
  lookups: Lookups; defaultFeatureId: string | null; onClose: () => void; onCreated: (row: IdeaRow) => void;
}) {
  const [title, setTitle] = useState('');
  const [ideaType, setType] = useState<string>('FEATURE_REQUEST');
  const [featureId, setFeature] = useState(defaultFeatureId ?? '');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ row: IdeaRow }>('/api/fh/ideas', { method: 'POST', body: { title, ideaType, featureId: featureId || null, description: description || null } });
      onCreated(r.row);
    } catch (x) {
      setErr({ field: x instanceof ApiFailure ? String(x.details?.field ?? '') : undefined, message: (x as Error).message });
      setBusy(false);
    }
  }
  const errFor = (f: string) => (err?.field === f ? 'new-idea-err' : undefined);
  return (
    <Dialog title="New idea" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm font-medium">Title
          <input className={`${input} mt-1 w-full`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required aria-describedby={errFor('title')} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium">Type
            <select className={`${input} mt-1 w-full`} value={ideaType} onChange={(e) => setType(e.target.value)}>
              {IDEA_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium">Feature
            <select className={`${input} mt-1 w-full`} value={featureId} onChange={(e) => setFeature(e.target.value)} aria-describedby={errFor('featureId')}>
              <option value="">No Feature</option>
              {orderedFeatures(lookups).map((f) => <option key={f.id} value={f.id}>{'  '.repeat(f.depth)}{f.name}</option>)}
            </select>
          </label>
        </div>
        <label className="block text-sm font-medium">Description
          <textarea className={`${input} mt-1 w-full`} rows={5} maxLength={10_000} value={description} onChange={(e) => setDescription(e.target.value)} aria-describedby={errFor('description')} />
        </label>
        {err && <p id="new-idea-err" role="alert" className="text-sm text-[var(--danger)]">{err.message}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="submit" className={btnPrimary} disabled={busy}>{busy ? 'Creating…' : 'Create idea'}</button>
        </div>
      </form>
    </Dialog>
  );
}
