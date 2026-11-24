import type { Metadata } from 'next';
import ShareView from '@/modules/jb/client/ui/ShareView';
import '../../jb/jb.css';

// SEC-12: no referrer, not indexed. Headers are also set for /b/* in next.config.ts.
export const metadata: Metadata = { title: 'Shared board', referrer: 'no-referrer', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function SharedBoardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ShareView token={token} />;
}
