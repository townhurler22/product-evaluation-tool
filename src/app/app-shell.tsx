'use client';

// Signed-in app shell: left navigation for both modules, collapsible to a top bar on narrow screens.
// Server routes enforce access (SEC-01); this only decides which links to show.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

export interface Me { userId: string; role: string; isFeedbackAdmin: boolean; isWorkspaceAdmin: boolean }

const NAV = [
  { heading: 'Feedback Hub', items: [
    { href: '/fh/ideas', label: 'Ideas' }, { href: '/fh/forums', label: 'Forums' },
    { href: '/fh/people', label: 'People & Companies' }, { href: '/fh/reporting', label: 'Reporting' },
  ] },
  { heading: 'Journey Boards', items: [{ href: '/jb', label: 'Boards' }] },
];

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null | 'loading'>('loading');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch('/api/me').then(async (r) => setMe(r.ok ? await r.json() : null)).catch(() => setMe(null));
  }, []);

  async function signOut() {
    await fetch('/api/auth/sign-out', { method: 'POST' });
    window.location.href = '/';
  }

  if (me === null) {
    return (
      <main className="mx-auto max-w-lg px-4 py-16">
        <p>Your session has ended. <button className="underline" onClick={signOut}>Sign in again</button></p>
      </main>
    );
  }

  const nav = (
    <nav aria-label="Main" className="flex h-full flex-col gap-4 p-3 text-sm">
      <Link href="/fh/ideas" className="px-2 text-base font-bold">Product Evaluation Tool</Link>
      {NAV.map((g) => (
        <div key={g.heading}>
          <h2 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{g.heading}</h2>
          <ul className="space-y-0.5">
            {g.items.map((it) => {
              const active = pathname === it.href || pathname.startsWith(`${it.href}/`);
              return (
                <li key={it.href}>
                  <Link href={it.href} onClick={() => setOpen(false)} aria-current={active ? 'page' : undefined}
                    className={`block rounded-md px-2 py-1.5 ${active ? 'bg-[var(--accent)] font-semibold text-[var(--accent-fg)]' : 'hover:bg-[var(--hover)]'}`}>
                    {it.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="mt-auto space-y-1 border-t border-[var(--border)] pt-3">
        {me !== 'loading' && me.isWorkspaceAdmin && <Link href="/admin" className="block rounded-md px-2 py-1.5 hover:bg-[var(--hover)]">Workspace admin</Link>}
        {me !== 'loading' && <p className="px-2 text-xs text-[var(--muted)]">Signed in as {me.role.toLowerCase()}</p>}
        <button onClick={signOut} className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-[var(--hover)]">Sign out</button>
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2 md:hidden">
        <Link href="/fh/ideas" className="font-bold">Product Evaluation Tool</Link>
        <button className="rounded-md border border-[var(--border)] px-3 py-1 text-sm" aria-expanded={open} aria-controls="main-nav" onClick={() => setOpen((o) => !o)}>
          Menu
        </button>
      </header>
      <div id="main-nav" className={`${open ? 'block' : 'hidden'} border-b border-[var(--border)] md:sticky md:top-0 md:block md:h-dvh md:w-52 md:shrink-0 md:border-b-0 md:border-r`}>
        {nav}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
