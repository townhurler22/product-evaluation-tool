'use client';
// "Mapped on boards" (FH-222, FH-605, FH-655, INT-52): Product cards linked to a Feature or a Journey, as the viewer.
// Cards the viewer cannot see are omitted; deleted cards read "deleted card". Each entry deep-links to the card (JB-105).
import { useQuery } from '@tanstack/react-query';
import { api } from '../_lib/api';

interface MappedCard { cardId: string; boardId: string; nodeId: string; title: string | null; boardName: string | null; deleted: boolean; isJourney: boolean }

export default function MappedOnBoards({ kind, id }: { kind: 'feature' | 'journey'; id: string | null }) {
  const q = useQuery({
    queryKey: ['fh', 'mapped', kind, id],
    queryFn: ({ signal }) => api<{ cards: MappedCard[] }>(`/api/fh/${kind === 'feature' ? 'features' : 'journeys'}/${id}/cards`, { signal }),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
  if (!id) return <p className="text-xs text-[var(--muted)]">{kind === 'feature' ? 'Set a Feature to see the cards it maps to.' : 'No Journey.'}</p>;
  if (q.isPending) return <p role="status" className="text-xs text-[var(--muted)]">Loading…</p>;
  if (q.isError) return <p role="alert" className="text-xs text-red-700">Could not load the boards.</p>;
  const cards = q.data.cards;
  if (!cards.length) return <p className="text-xs text-[var(--muted)]">Not mapped on any board you can see.</p>;
  return (
    <ul className="flex flex-col gap-1 text-sm" aria-label="Mapped on boards">
      {cards.map((c) => (
        <li key={c.cardId}>
          {c.deleted ? <span className="text-[var(--muted)]">deleted card</span> : (
            <a className="underline" href={`/jb/${c.boardId}?node=${encodeURIComponent(c.nodeId)}`}>
              {c.title || 'Untitled card'} <span className="text-[var(--muted)]">on {c.boardName}{c.isJourney ? ' (detailed journey)' : ''}</span>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
