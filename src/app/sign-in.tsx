'use client';

import { useState } from 'react';

export default function SignIn({ demo }: { demo: boolean }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function sendLink(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState('sending');
    const email = new FormData(e.currentTarget).get('email');
    const res = await fetch('/api/auth/magic-link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    });
    const body = await res.json();
    setMessage(body.message);
    setState(res.ok ? 'sent' : 'error');
  }

  async function tryDemo() {
    const res = await fetch('/api/auth/demo', { method: 'POST' });
    if (res.ok) window.location.reload();
    else { setMessage((await res.json()).message); setState('error'); }
  }

  return (
    <div className="space-y-8">
      {demo && (
        <section>
          <button onClick={tryDemo} className="w-full rounded-lg bg-[var(--accent)] px-5 py-3 font-semibold text-white dark:text-black">
            Try the demo
          </button>
          <p className="mt-2 text-sm text-[var(--muted)]">A shared sandbox with sample data. It resets every night.</p>
        </section>
      )}
      <form onSubmit={sendLink} className="space-y-3" aria-describedby="signin-status">
        <label className="block text-sm font-medium">
          Email
          <input name="email" type="email" required autoComplete="email"
            className="mt-1 block w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2" />
        </label>
        <button type="submit" disabled={state === 'sending'}
          className="rounded-lg border border-[var(--border)] px-5 py-2 font-medium disabled:opacity-60">
          {state === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
        </button>
        <p id="signin-status" role="status" className="text-sm text-[var(--muted)]">{message}</p>
      </form>
    </div>
  );
}
