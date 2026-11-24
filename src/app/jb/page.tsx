import type { Metadata } from 'next';
import BoardsHome from '@/modules/jb/client/ui/BoardsHome';
import './jb.css';

export const metadata: Metadata = { title: 'Journey Boards | Product Evaluation Tool' };

export default function JourneyBoardsPage() {
  return <BoardsHome />;
}
