import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/modules/core/auth/session';
import { isDemoMode } from '@/modules/core/auth/sign-in';
import SignIn from './sign-in';
import SignedIn from './signed-in';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const hasSession = (await cookies()).has(SESSION_COOKIE);
  return (
    <main className="mx-auto max-w-lg px-4 py-16">
      <h1 className="text-3xl font-bold tracking-tight">Product Evaluation Tool</h1>
      <p className="mt-2 text-[var(--muted)]">
        Collect what clients ask for, triage it into a roadmap, and see demand on your user-journey maps.
      </p>
      <div className="mt-10">{hasSession ? <SignedIn /> : <SignIn demo={isDemoMode()} />}</div>
    </main>
  );
}
