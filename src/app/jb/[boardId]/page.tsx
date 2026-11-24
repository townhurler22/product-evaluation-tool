import type { Metadata } from 'next';
import BoardApp from '@/modules/jb/client/ui/BoardApp';
import '../jb.css';

export const metadata: Metadata = { title: 'Board | Journey Boards' };

// JB-105: /jb/<boardId>?node=<nodeId> opens the board, centres the card and opens its details.
export default async function BoardPage({ params, searchParams }: { params: Promise<{ boardId: string }>; searchParams: Promise<{ node?: string }> }) {
  const { boardId } = await params;
  const { node } = await searchParams;
  return <BoardApp boardId={boardId} deepNodeId={typeof node === 'string' ? node : null} />;
}
