import { notFound } from 'next/navigation';
import { VIEWS } from '@/modules/fh/domain';

// FH-002: each view tab has its own URL (/fh/ideas, /fh/ideas/triage, ...). The workspace in the layout renders it.
export default async function IdeasViewPage({ params }: { params: Promise<{ view?: string[] }> }) {
  const { view } = await params;
  if (view && (view.length > 1 || !(VIEWS as readonly string[]).includes(view[0]) || view[0] === 'all')) notFound();
  return null;
}
