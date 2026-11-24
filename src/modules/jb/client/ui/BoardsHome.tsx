'use client';
// Journey Boards home (JB-101 to JB-103, JB-1902): board metadata only (PERF-24); create blank, from the
// sample template, or by importing an export file. Import creates new boards; it never overwrites.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import type { BoardMeta } from '../../server/access';

export default function BoardsHome() {
  const router = useRouter();
  const [boards, setBoards] = useState<BoardMeta[] | null>(null);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<'blank' | 'sample'>('blank');
  const [msg, setMsg] = useState('');
  const [failed, setFailed] = useState(false);

  const load = async () => {
    setFailed(false);
    const r = await fetch('/api/jb/boards').catch(() => null);
    if (r?.status === 401) { window.location.href = '/'; return; }
    if (!r?.ok) { setFailed(true); return; }
    setBoards((await r.json()).boards);
  };
  // Fetch on mount; state is set after the response arrives.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setMsg('');
    const r = await fetch('/api/jb/boards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() || (template === 'sample' ? 'Sample product map' : 'Untitled board'), template }) });
    const b = await r.json();
    if (!r.ok) { setMsg(b.message ?? 'Could not create the board'); return; }
    router.push(`/jb/${b.meta.id}`);
  };

  const importFile = async (file: File) => {
    setMsg('Importing…');
    let doc: unknown;
    try { doc = JSON.parse(await file.text()); } catch { setMsg('That file is not a board export.'); return; }
    const r = await fetch('/api/jb/boards/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) });
    const b = await r.json();
    if (!r.ok) { setMsg(`${b.message ?? 'Import failed'}${b.details?.field ? ` (at ${b.details.field})` : ''}`); return; }
    setMsg(`Imported ${b.boards.length} ${b.boards.length === 1 ? 'board' : 'boards'}.`);
    await load();
  };

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <p><Link href="/" className="underline">Home</Link></p>
      <h1 className="mt-4 text-2xl font-bold">Journey Boards</h1>
      {failed && <p role="alert">We could not load your boards. <button type="button" className="underline" onClick={() => void load()}>Try again</button></p>}
      {!boards && !failed && <p role="status">Loading boards…</p>}
      {boards && (
        <ul className="mt-6 divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {boards.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <Link href={`/jb/${b.id}`} className="font-medium underline-offset-2 hover:underline">{b.name}</Link>
              <span className="text-sm text-[var(--muted)]">
                {b.nodeCount} cards · {b.ownerName ?? 'Owner'} · {b.rights.canEdit ? 'Can edit' : b.rights.canComment ? 'Can comment' : 'View only'}
              </span>
            </li>
          ))}
          {!boards.length && <li className="px-4 py-3 text-[var(--muted)]">No boards yet. Create one below.</li>}
        </ul>
      )}
      <form onSubmit={create} className="mt-8 flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-sm">Board name
          <input className="rounded border border-[var(--border)] bg-transparent px-2 py-1" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col text-sm">Start from
          <select className="rounded border border-[var(--border)] bg-transparent px-2 py-1" value={template} onChange={(e) => setTemplate(e.target.value as 'blank' | 'sample')}>
            <option value="blank">Blank board</option>
            <option value="sample">Sample product map</option>
          </select>
        </label>
        <button type="submit" className="rounded-lg border border-[var(--border)] px-4 py-2">Create board</button>
        <label className="rounded-lg border border-[var(--border)] px-4 py-2 cursor-pointer">Import a board file
          <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
        </label>
      </form>
      {msg && <p role="status" className="mt-3">{msg}</p>}
    </main>
  );
}
