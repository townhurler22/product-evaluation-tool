'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type Me = { role: string; isWorkspaceAdmin: boolean } | null;

export default function SignedIn() {
  const [me, setMe] = useState<Me | 'loading'>('loading');
  useEffect(() => {
    fetch('/api/me').then(async (r) => setMe(r.ok ? await r.json() : null));
  }, []);

  async function signOut() {
    await fetch('/api/auth/sign-out', { method: 'POST' });
    window.location.reload();
  }

  if (me === 'loading') return <p role="status">Loading…</p>;
  if (!me) return <p>Your session has ended. <button className="underline" onClick={signOut}>Sign in again</button></p>;
  return (
    <div className="space-y-4">
      <p>You&apos;re signed in ({me.role.toLowerCase()}). Feedback Hub and Journey Boards arrive in phases P1 and P4.</p>
      <div className="flex gap-3">
        {me.isWorkspaceAdmin && <Link href="/admin" className="rounded-lg border border-[var(--border)] px-4 py-2">Workspace admin</Link>}
        <button onClick={signOut} className="rounded-lg border border-[var(--border)] px-4 py-2">Sign out</button>
      </div>
    </div>
  );
}
