'use client';

// Saved views menu (FH-901–904): apply, save current, update, rename, delete. Built-ins cannot be deleted.
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { View } from '@/modules/fh/domain';
import { api } from '../_lib/api';
import { keys } from '../_lib/data';
import { btn, input } from './ui';

interface SavedView { id: string; name: string; ownerId: string | null; isShared: boolean; builtIn: boolean; config: { view: View } & Record<string, unknown> }

export default function SavedViews({ activeId, isAdmin, onApply, currentConfig }: {
  activeId: string | null; isAdmin: boolean;
  onApply: (cfg: SavedView['config'], id: string) => void;
  currentConfig: () => Record<string, unknown>;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [msg, setMsg] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const views = useQuery({ queryKey: keys.savedViews, queryFn: () => api<{ views: SavedView[] }>('/api/fh/saved-views'), staleTime: 5 * 60_000 });
  const me = (qc.getQueryData(keys.lookups) as { access?: { userId: string } } | undefined)?.access?.userId;
  const active = views.data?.views.find((v) => v.id === activeId);

  // FH-902: a shared URL carries the saved view id; apply it once the list arrives.
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (active && applied.current !== active.id && !active.builtIn) { applied.current = active.id; onApply(active.config, active.id); }
  }, [active, onApply]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const refresh = () => qc.invalidateQueries({ queryKey: keys.savedViews });
  async function act(fn: () => Promise<unknown>, done: string) {
    try { await fn(); setMsg(done); refresh(); } catch (e) { setMsg((e as Error).message); }
  }
  const canChange = (v: SavedView) => !v.builtIn && (v.ownerId === me || (v.isShared && isAdmin));

  return (
    <div ref={ref} className="relative">
      <button className={btn} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        {active ? `View: ${active.name}` : 'Saved views'}
      </button>
      {open && (
        <div role="dialog" aria-label="Saved views" className="absolute left-0 z-30 mt-1 w-80 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 text-sm shadow-lg">
          <ul className="max-h-64 overflow-auto">
            {views.data?.views.map((v) => (
              <li key={v.id} className="flex items-center gap-1">
                <button className={`min-w-0 flex-1 truncate rounded px-2 py-1 text-left hover:bg-[var(--hover)] ${v.id === activeId ? 'font-semibold' : ''}`}
                  onClick={() => { applied.current = v.id; onApply(v.config, v.id); setOpen(false); }}>
                  {v.name}{v.isShared && !v.builtIn ? ' (shared)' : ''}
                </button>
                {canChange(v) && (
                  <>
                    <button className="rounded px-1 text-xs underline" onClick={() => act(() => api(`/api/fh/saved-views/${v.id}`, { method: 'PATCH', body: { config: currentConfig() } }), `Saved changes to ${v.name}.`)}>Save changes</button>
                    <button className="rounded px-1 text-xs underline" onClick={() => { const n = window.prompt('Rename view', v.name); if (n) void act(() => api(`/api/fh/saved-views/${v.id}`, { method: 'PATCH', body: { name: n } }), 'Renamed.'); }}>Rename</button>
                    <button className="rounded px-1 text-xs text-[var(--danger)] underline" onClick={() => { if (window.confirm(`Delete the view "${v.name}"?`)) void act(() => api(`/api/fh/saved-views/${v.id}`, { method: 'DELETE' }), 'Deleted.'); }}>Delete</button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <form className="mt-2 space-y-1 border-t border-[var(--border)] pt-2" onSubmit={(e) => {
            e.preventDefault();
            void act(() => api('/api/fh/saved-views', { method: 'POST', body: { name, isShared: shared, config: currentConfig() } }), `Saved "${name}".`);
            setName('');
          }}>
            <label className="block">Save the current view as
              <input className={`${input} mt-1 w-full`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
            </label>
            {isAdmin && <label className="flex items-center gap-2"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with all members</label>}
            <button type="submit" className={btn}>Save view</button>
          </form>
          {msg && <p role="status" className="mt-1 text-xs">{msg}</p>}
        </div>
      )}
    </div>
  );
}
