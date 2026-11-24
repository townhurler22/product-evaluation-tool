'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/** A signed-in visitor to the start page goes straight to Feedback Hub; an ended session can sign in again. */
export default function SignedIn() {
  const router = useRouter();
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    fetch('/api/me').then((r) => (r.ok ? router.replace('/fh/ideas') : setEnded(true))).catch(() => setEnded(true));
  }, [router]);

  async function signOut() {
    await fetch('/api/auth/sign-out', { method: 'POST' });
    window.location.reload();
  }

  if (!ended) return <p role="status">Opening Feedback Hub…</p>;
  return <p>Your session has ended. <button className="underline" onClick={signOut}>Sign in again</button></p>;
}
