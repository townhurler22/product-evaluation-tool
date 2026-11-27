import type { Metadata } from 'next';
import ForumView from './forum-view';

// SEC-12: no referrer, not indexed, never cached. Headers are also set for /f/* in next.config.ts.
export const metadata: Metadata = { title: 'Feedback forum', referrer: 'no-referrer', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function ForumPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ForumView token={token} />;
}
