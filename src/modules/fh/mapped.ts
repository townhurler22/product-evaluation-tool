// "Mapped on boards" (FH-222, FH-605, FH-655, INT-52): one link read by the to-end plus one batched card resolve as
// the viewer (INT-32). Cards the viewer cannot see are omitted; deleted cards show as "deleted card".
import { links, type Principal } from '@/modules/core/service';
import { resolveCards } from '@/modules/jb/service';

export interface MappedCard { cardId: string; boardId: string; nodeId: string; title: string | null; boardName: string | null; deleted: boolean; isJourney: boolean }

/** 2 statements. */
export async function mappedOnBoards(viewer: Principal, kind: 'feature' | 'journey', id: string): Promise<{ cards: MappedCard[] }> {
  const relation = kind === 'feature' ? 'maps-to-feature' : 'maps-to-journey';
  const rows = (await links.listTo(kind, [id.toLowerCase()], [relation]))[id.toLowerCase()] ?? [];
  const refs = await resolveCards(viewer, rows.map((l) => l.fromId));
  const cards: MappedCard[] = [];
  for (const l of rows) {
    const r = refs[l.fromId];
    if (r === undefined) continue; // a board the viewer cannot see
    const [boardId, nodeId] = l.fromId.split(':');
    cards.push(r === 'gone'
      ? { cardId: l.fromId, boardId, nodeId, title: null, boardName: null, deleted: true, isJourney: false }
      : { cardId: l.fromId, boardId: r.boardId, nodeId: r.nodeId, title: r.title, boardName: r.boardName, deleted: false, isJourney: r.isJourney });
  }
  return { cards };
}
