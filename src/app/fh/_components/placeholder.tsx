'use client';

import { useLookups } from '../_lib/data';

export default function Placeholder({ title, note, adminOnly }: { title: string; note: string; adminOnly?: boolean }) {
  const lookups = useLookups();
  const admin = lookups.data?.access.feedbackAdmin;
  return (
    <main className="px-4 py-6">
      <h1 className="text-2xl font-bold">{title}</h1>
      {/* FH-007: the section is visible to everyone; non-admins see why there is no content. */}
      {adminOnly && lookups.data && !admin
        ? <p className="mt-4">Forum administration is for feedback admins.</p>
        : <p className="mt-4 text-[var(--muted)]">{note}</p>}
    </main>
  );
}
