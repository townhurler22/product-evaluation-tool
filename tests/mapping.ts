// Journey mapping test helpers (P5): routes for links, overlay, panel, sync and Mapped on boards.
import { call } from './http';
import { createBoard, sendOps, card } from './jb';
import { GET as overlayRoute } from '@/app/api/jb/boards/[id]/overlay/route';
import { GET as linksGet, POST as linksPost, DELETE as linksDelete } from '@/app/api/jb/boards/[id]/nodes/[nodeId]/links/route';
import { GET as demandRoute } from '@/app/api/jb/boards/[id]/nodes/[nodeId]/demand/route';
import { GET as ideasRoute } from '@/app/api/jb/boards/[id]/nodes/[nodeId]/ideas/route';
import { GET as breakdownRoute } from '@/app/api/jb/boards/[id]/nodes/[nodeId]/breakdown/route';
import { GET as journeyRoute } from '@/app/api/jb/boards/[id]/nodes/[nodeId]/journey/route';
import { POST as syncRoute } from '@/app/api/jb/boards/[id]/nodes/[nodeId]/journey-sync/route';
import { GET as searchRoute } from '@/app/api/jb/boards/[id]/feature-search/route';
import { GET as changesRoute } from '@/app/api/jb/boards/[id]/changes/route';
import { GET as featureCards } from '@/app/api/fh/features/[id]/cards/route';
import { GET as journeyCards } from '@/app/api/fh/journeys/[id]/cards/route';

export const product = (id: string, title = id, x = 0) => card(id, x, 0, { title }, 'product-card');

/** A top-level board with Product cards, each optionally with a detailed journey. */
export async function boardWithJourneys(cookie: string, cards: { id: string; title?: string; journey?: boolean }[]) {
  const board = (await createBoard(cookie, { name: 'Map' })).meta.id;
  const r = await sendOps(cookie, board, cards.map((c, i) => product(c.id, c.title ?? c.id, i * 300)));
  if (r.status !== 200) throw new Error(`ops ${r.status} ${JSON.stringify(r.body)}`);
  const journeys: Record<string, string> = {};
  for (const c of cards.filter((x) => x.journey)) {
    journeys[c.id] = (await createBoard(cookie, { name: `${c.title ?? c.id}: detailed journey`, journeyOf: { boardId: board, nodeId: c.id } })).meta.id;
  }
  return { board, journeys };
}

export const overlay = (cookie: string, boardId: string, scope = 'open') =>
  call(overlayRoute, { cookie, path: `/api/jb/boards/${boardId}/overlay?scope=${scope}`, params: { id: boardId } });
export const link = (cookie: string, boardId: string, nodeId: string, featureId: string, relation?: string) =>
  call(linksPost, { method: 'POST', cookie, path: `/api/jb/boards/${boardId}/nodes/${nodeId}/links`, params: { id: boardId, nodeId }, body: { featureId, ...(relation && { relation }) } });
export const unlink = (cookie: string, boardId: string, nodeId: string, toId: string, relation = 'maps-to-feature') =>
  call(linksDelete, { method: 'DELETE', cookie, path: `/api/jb/boards/${boardId}/nodes/${nodeId}/links?relation=${relation}&toId=${toId}`, params: { id: boardId, nodeId } });
export const links = (cookie: string, boardId: string, nodeId: string) =>
  call(linksGet, { cookie, path: `/api/jb/boards/${boardId}/nodes/${nodeId}/links`, params: { id: boardId, nodeId } });
export const panel = (cookie: string, boardId: string, nodeId: string, scope = 'open') =>
  call(demandRoute, { cookie, path: `/api/jb/boards/${boardId}/nodes/${nodeId}/demand?scope=${scope}`, params: { id: boardId, nodeId } });
export const journey = (cookie: string, boardId: string, nodeId: string) =>
  call(journeyRoute, { cookie, path: `/api/jb/boards/${boardId}/nodes/${nodeId}/journey`, params: { id: boardId, nodeId } });
export const ideas = (cookie: string, boardId: string, nodeId: string, q = '') =>
  call(ideasRoute, { cookie, path: `/api/jb/boards/${boardId}/nodes/${nodeId}/ideas?${q}`, params: { id: boardId, nodeId } });
export const breakdown = (cookie: string, boardId: string, nodeId: string, scope = 'open') =>
  call(breakdownRoute, { cookie, path: `/api/jb/boards/${boardId}/nodes/${nodeId}/breakdown?scope=${scope}`, params: { id: boardId, nodeId } });
export const sync = (cookie: string, boardId: string, nodeId: string) =>
  call(syncRoute, { method: 'POST', cookie, path: `/api/jb/boards/${boardId}/nodes/${nodeId}/journey-sync`, params: { id: boardId, nodeId } });
export const search = (cookie: string, boardId: string, q: string) =>
  call(searchRoute, { cookie, path: `/api/jb/boards/${boardId}/feature-search?q=${encodeURIComponent(q)}`, params: { id: boardId } });
export const changes = (cookie: string, boardId: string, since = 0) =>
  call(changesRoute, { cookie, path: `/api/jb/boards/${boardId}/changes?since=${since}`, params: { id: boardId } });
export const mappedFeature = (cookie: string, id: string) => call(featureCards, { cookie, params: { id } });
export const mappedJourney = (cookie: string, id: string) => call(journeyCards, { cookie, params: { id } });
