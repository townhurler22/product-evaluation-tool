// Journey mapping and demand (SPEC §9): card links, the demand overlay, the Product card panel, Feature search,
// the Journey sync and the jb.demand.notify job. Feedback Hub data comes only through its service (ARC-01) and
// links only through Core's link service (ARC-06). Every read is batched: statement counts never depend on the
// number of cards, journeys or boards (D-18, D-19, D-26, PERF-B16, PERF-B19).
import { sql } from 'kysely';
import type { BoardLinks, DemandScope, FeatureRef, JourneyRef, Link } from '@pet/contracts';
import { links, registerJob, type Principal } from '@/modules/core/service';
import * as feedbackHub from '@/modules/fh/service';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { effectiveRights, type CollaboratorRole } from '../rights';
import { loadBoard, notFound, requireEdit, type BoardAccess } from './access';
import { boardChannel, emit } from './events';

export type Level = 'journey' | 'feature';
export type Attention = { relation: 'maps-to-feature' | 'maps-to-journey'; toId: string }[];
const FEATURE = 'maps-to-feature' as const;
const JOURNEY = 'maps-to-journey' as const;
const NODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const cardIdOf = (boardId: string, nodeId: string) => `${boardId}:${nodeId}`;
/** INT-01: the level is derived on the server from the card's board, never from the client. */
export const levelOf = (a: BoardAccess): Level => (a.row.journey_of_board_id ? 'feature' : 'journey');
const unavailable = { available: false as const };

export function parseScope(raw: string | null): DemandScope {
  if (raw === null || raw === '' || raw === 'open') return 'open';
  if (raw === 'all') return 'all';
  throw new ApiError('validation', 'scope must be open or all.', { field: 'scope' });
}

// ── card sets (INT-10, INT-49): computed once per request from the board-scoped link index ──
export interface CardSets {
  /** Live Product cards on the board itself, by node id. */
  cards: Map<string, { nodeId: string; title: string }>;
  /** Feature ids per card on this board (journey level: its own links; top level: its journey's live cards' links). */
  sets: Map<string, string[]>;
  /** A card is "linked" when its set has at least one Feature link (INT-36). */
  linked: Set<string>;
  /** Top level: each card's Journey link ids, and its detailed journey board (if any). */
  journeyLinks: Map<string, string[]>;
  journeyBoard: Map<string, string>;
  /** Journey level: each card's Feature links (for the panel list and attention). */
  featureLinks: Map<string, string[]>;
}

export function cardSets(boardId: string, level: Level, bl: BoardLinks): CardSets {
  const live = new Set(bl.cards.map((c) => c.cardId));
  const byFrom = new Map<string, Link[]>();
  for (const l of bl.links) if (live.has(l.fromId)) { const xs = byFrom.get(l.fromId) ?? []; xs.push(l); byFrom.set(l.fromId, xs); }
  const featuresOf = (cardId: string) => (byFrom.get(cardId) ?? []).filter((l) => l.relation === FEATURE).map((l) => l.toId);
  const out: CardSets = { cards: new Map(), sets: new Map(), linked: new Set(), journeyLinks: new Map(), journeyBoard: new Map(), featureLinks: new Map() };
  for (const c of bl.cards) if (c.boardId === boardId) out.cards.set(c.nodeId, { nodeId: c.nodeId, title: c.title });
  if (level === 'feature') {
    for (const nodeId of out.cards.keys()) {
      const f = featuresOf(cardIdOf(boardId, nodeId));
      out.featureLinks.set(nodeId, f);
      out.sets.set(nodeId, f);
      if (f.length) out.linked.add(nodeId);
    }
    return out;
  }
  const journeyCards = new Map<string, string[]>(); // journey board → its live card ids
  for (const c of bl.cards) if (c.boardId !== boardId) { const xs = journeyCards.get(c.boardId) ?? []; xs.push(c.cardId); journeyCards.set(c.boardId, xs); }
  for (const s of bl.scopes) if (s.rootBoardId === boardId && s.parentNodeId) out.journeyBoard.set(s.parentNodeId, s.boardId);
  for (const nodeId of out.cards.keys()) {
    const jb = out.journeyBoard.get(nodeId);
    const set = new Set<string>();
    if (jb) for (const cid of journeyCards.get(jb) ?? []) for (const f of featuresOf(cid)) set.add(f);
    out.sets.set(nodeId, [...set]);
    if (set.size) out.linked.add(nodeId);
    out.journeyLinks.set(nodeId, (byFrom.get(cardIdOf(boardId, nodeId)) ?? []).filter((l) => l.relation === JOURNEY).map((l) => l.toId));
  }
  return out;
}

async function boardSets(a: BoardAccess) {
  const level = levelOf(a);
  const bl = await links.linksForBoard({ boardIds: [a.row.id], includeJourneys: level === 'journey', relations: level === 'journey' ? [FEATURE, JOURNEY] : [FEATURE] });
  return { level, bl, cs: cardSets(a.row.id, level, bl) };
}

/** INT-28: a gone Feature flags the journey-level card that links it; a gone Journey flags the top-level card. */
function attentionFor(level: Level, nodeId: string, cs: CardSets, goneFeatures: string[], goneJourneys: Set<string>): Attention {
  if (level === 'feature') return goneFeatures.map((toId) => ({ relation: FEATURE, toId }));
  return (cs.journeyLinks.get(nodeId) ?? []).filter((j) => goneJourneys.has(j)).map((toId) => ({ relation: JOURNEY, toId }));
}

// ── overlay (PERF-30, INT-33 to INT-39): ≤ 4 statements whatever the number of cards ──
export interface Overlay {
  available: true; scope: DemandScope; level: Level; demandRev: number;
  counts: Record<string, number>; releaseDates: Record<string, string | null>; attention: Record<string, Attention>;
}

export async function overlay(principal: Principal, boardId: string, scope: DemandScope): Promise<Overlay | typeof unavailable> {
  const a = await loadBoard(principal, boardId);
  if (!feedbackHub.hasAccess(principal)) return unavailable; // ARC-19, INT-38
  const { level, cs } = await boardSets(a);
  const journeyIds = level === 'journey' ? [...new Set([...cs.journeyLinks.values()].flat())] : [];
  const sets: Record<string, string[]> = {};
  for (const [nodeId, set] of cs.sets) if (set.length) sets[nodeId] = set;
  const counts: Record<string, number> = {}; const releaseDates: Record<string, string | null> = {}; const attention: Record<string, Attention> = {};
  if (!Object.keys(sets).length && !journeyIds.length) return { available: true, scope, level, demandRev: a.row.demand_rev ?? 0, counts, releaseDates, attention };
  const d = await feedbackHub.demandForSets(principal, { sets, scope, journeyIds });
  if (!d.available) return unavailable;
  const goneJourneys = new Set(d.goneJourneyIds);
  for (const nodeId of cs.cards.keys()) {
    const r = d.bySet[nodeId];
    if (cs.linked.has(nodeId) && r) { counts[nodeId] = r.count; releaseDates[nodeId] = r.targetDate; }
    const att = attentionFor(level, nodeId, cs, r?.goneFeatureIds ?? [], goneJourneys);
    if (att.length) attention[nodeId] = att;
  }
  return { available: true, scope, level, demandRev: a.row.demand_rev ?? 0, counts, releaseDates, attention };
}

// ── panel summary (INT-42, INT-43, INT-48): the overlay's sets, 1 request, same statements ──
export async function panelSummary(principal: Principal, boardId: string, nodeId: string, scope: DemandScope) {
  if (!NODE_RE.test(nodeId)) throw notFound();
  const a = await loadBoard(principal, boardId);
  const { level, cs } = await boardSets(a);
  const card = cs.cards.get(nodeId);
  if (!card) throw notFound(); // not a live Product card (INT-45: the client retries while the card is saving)
  const journeyBoardId = level === 'journey' ? cs.journeyBoard.get(nodeId) ?? null : null;
  const base = { level, journeyBoardId, canEdit: a.rights.canEdit };
  if (!feedbackHub.hasAccess(principal)) return { ...base, available: false as const };
  const set = cs.sets.get(nodeId) ?? [];
  const journeyIds = level === 'journey' ? cs.journeyLinks.get(nodeId) ?? [] : [];
  const linkedFeatures = level === 'feature' ? cs.featureLinks.get(nodeId) ?? [] : [];
  const d = await feedbackHub.demandForSets(principal, { sets: { card: set }, scope, journeyIds, describe: level === 'feature' });
  if (!d.available) return { ...base, available: false as const };
  const r = d.bySet.card ?? { count: 0, targetDate: null, goneFeatureIds: [] };
  const attention = attentionFor(level, nodeId, cs, r.goneFeatureIds, new Set(d.goneJourneyIds));
  const common = { ...base, available: true as const, scope, linked: cs.linked.has(nodeId), total: r.count, targetDate: r.targetDate, attention };
  if (level === 'feature') {
    const features: (FeatureRef | { id: string; gone: true })[] = linkedFeatures.map((id) => d.features[id.toLowerCase()] ?? { id, gone: true as const });
    return { ...common, features };
  }
  // INT-42: linked, not in Feedback Hub yet, gone, plus a name warning when titles differ ignoring case and spaces.
  const jid = journeyIds[0] ?? null;
  const ref: JourneyRef | undefined = jid ? d.journeys[jid.toLowerCase()] : undefined;
  const journey = !jid ? { state: 'none' as const } : ref
    ? { state: 'linked' as const, ...ref, nameDiffers: ref.name.trim().toLowerCase() !== card.title.trim().toLowerCase() }
    : { state: 'gone' as const, id: jid };
  return { ...common, journey, featureCount: set.length, featureIds: set };
}

/** The Feature set a card's ideas and breakdown read, optionally narrowed to one linked Feature (INT-40). */
async function setForCard(principal: Principal, boardId: string, nodeId: string, featureId: string | null) {
  if (!NODE_RE.test(nodeId)) throw notFound();
  const a = await loadBoard(principal, boardId);
  const { cs } = await boardSets(a);
  if (!cs.cards.has(nodeId)) throw notFound();
  const set = cs.sets.get(nodeId) ?? [];
  if (featureId !== null && !set.includes(featureId)) throw notFound();
  return featureId !== null ? [featureId] : set;
}

export async function cardIdeas(principal: Principal, boardId: string, nodeId: string, q: { scope: DemandScope; featureId: string | null; cursor: string | null }) {
  const set = await setForCard(principal, boardId, nodeId, q.featureId);
  return feedbackHub.ideasUnder(principal, { featureIds: set, scope: q.scope, limit: 20, cursor: q.cursor });
}

export async function cardBreakdown(principal: Principal, boardId: string, nodeId: string, scope: DemandScope) {
  const set = await setForCard(principal, boardId, nodeId, null);
  return feedbackHub.breakdown(principal, { featureIds: set, scope });
}

export async function featureSearch(principal: Principal, boardId: string, q: string) {
  await loadBoard(principal, boardId);
  return feedbackHub.searchFeatures(principal, { query: q, limit: 20 });
}

// ── card links (INT-01 to INT-05, INT-31) ──
async function liveProductCard(boardId: string, nodeId: string) {
  const n = await getDb().selectFrom('jb_node').select(['kind', 'data']).where('board_id', '=', boardId).where('id', '=', nodeId)
    .where('deleted_at', 'is', null).executeTakeFirst();
  return n ?? null;
}

/** One statement: bump the demand revision of the boards and their top-level parents, then tell open clients (PERF-31). */
export async function notifyBoards(boardIds: string[]) {
  const ids = [...new Set(boardIds)];
  if (!ids.length) return [];
  const { rows } = await sql<{ id: string; demand_rev: number }>`
    UPDATE jb_board SET demand_rev = demand_rev + 1
    WHERE id = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)))
       OR id IN (SELECT journey_of_board_id FROM jb_board WHERE id = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))))
    RETURNING id, demand_rev::float8 AS demand_rev`.execute(getDb());
  for (const r of rows) emit(boardChannel(r.id), 'demand.changed', { demandRev: r.demand_rev });
  return rows.map((r) => r.id);
}

export async function listCardLinks(principal: Principal, boardId: string, nodeId: string) {
  if (!NODE_RE.test(nodeId)) throw notFound();
  const a = await loadBoard(principal, boardId);
  const all = (await links.listFrom('card', [cardIdOf(boardId, nodeId)]))[cardIdOf(boardId, nodeId)] ?? [];
  const level = levelOf(a);
  if (!feedbackHub.hasAccess(principal)) return { available: false as const, level };
  const fIds = all.filter((l) => l.relation === FEATURE).map((l) => l.toId);
  const jIds = all.filter((l) => l.relation === JOURNEY).map((l) => l.toId);
  const resolved = level === 'feature' ? await feedbackHub.resolveFeatures(principal, fIds) : await feedbackHub.resolveJourneys(principal, jIds);
  const refs = 'available' in resolved ? {} : resolved as Record<string, unknown>;
  return {
    available: true as const, level,
    links: all.map((l) => ({ relation: l.relation, toId: l.toId, createdAt: l.createdAt, target: refs[l.toId] ?? null })),
  };
}

export async function addCardLink(principal: Principal, boardId: string, nodeId: string, body: { relation?: string; featureId: string }) {
  if (!NODE_RE.test(nodeId)) throw notFound();
  const a = await requireEdit(principal, boardId);
  if (!feedbackHub.hasAccess(principal)) throw new ApiError('forbidden', 'You do not have access to Feedback Hub.', { available: false });
  // INT-02: the relation must match the board's level.
  if (levelOf(a) === 'journey' || body.relation === JOURNEY) {
    throw new ApiError('rule_violation', levelOf(a) === 'journey' ? 'Cards on a top-level board link a Journey through Sync.' : 'Cards in a detailed journey link Features.');
  }
  const n = await liveProductCard(boardId, nodeId);
  if (!n) throw notFound(); // INT-05: creating a link needs a live card
  if (n.kind !== 'product-card') throw new ApiError('rule_violation', 'Only Product cards link to Feedback Hub.');
  const f = await feedbackHub.resolveFeatures(principal, [body.featureId]);
  if (!('available' in f) && f[body.featureId] === 'gone') throw new ApiError('rule_violation', 'That Feature no longer exists.', { field: 'featureId' });
  const { created } = await links.createLink('jb', { relation: FEATURE, fromKind: 'card', fromId: cardIdOf(boardId, nodeId), fromScopeId: boardId, toKind: 'feature', toId: body.featureId.toLowerCase() }, principal.userId);
  await notifyBoards([boardId]);
  return { created, link: { relation: FEATURE, toId: body.featureId.toLowerCase() } };
}

/** INT-05: removing needs edit rights only, so a link on a deleted card or to a deleted Feature can be cleared. */
export async function removeCardLink(principal: Principal, boardId: string, nodeId: string, q: { relation: string; toId: string }) {
  if (!NODE_RE.test(nodeId)) throw notFound();
  await requireEdit(principal, boardId);
  if (q.relation !== FEATURE && q.relation !== JOURNEY) throw new ApiError('validation', 'Unknown relation.', { field: 'relation' });
  const { removed } = await links.removeLink('jb', { relation: q.relation, fromKind: 'card', fromId: cardIdOf(boardId, nodeId), toKind: q.relation === FEATURE ? 'feature' : 'journey', toId: q.toId });
  await notifyBoards([boardId]);
  return { removed };
}

// ── Journey sync (§9.4) ──
interface CardInfo {
  cardId: string; live: boolean; kind: string | null; title: string; boardId: string | null; boardName: string | null;
  topLevel: boolean; journeyBoardId: string | null; canView: boolean;
}

/** Cards by id with liveness, level, detailed journey and the viewer's view right. One statement (≤ 2,000 ids). */
async function cardsInfo(principal: Principal, cardIds: string[]): Promise<Map<string, CardInfo>> {
  const ids = [...new Set(cardIds)].filter((c) => /^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(c)).slice(0, 2000);
  if (!ids.length) return new Map();
  const { rows } = await sql<{ card_id: string; kind: string | null; title: string | null; live: boolean; board_id: string | null; board_name: string | null;
    top_level: boolean; journey_board_id: string | null; owner_id: string | null; wce: boolean | null; collab_role: CollaboratorRole | null }>`
    SELECT x.card_id, n.kind, n.data->>'title' AS title, (n.id IS NOT NULL AND n.deleted_at IS NULL) AS live,
           b.id AS board_id, b.name AS board_name, b.journey_of_board_id IS NULL AS top_level, jy.id AS journey_board_id,
           coalesce(p.owner_id, b.owner_id) AS owner_id, coalesce(p.workspace_can_edit, b.workspace_can_edit) AS wce, c.role AS collab_role
    FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS x(card_id)
    LEFT JOIN jb_board b ON b.id = split_part(x.card_id, ':', 1)
    LEFT JOIN jb_board p ON p.id = b.journey_of_board_id
    LEFT JOIN jb_collaborator c ON c.board_id = coalesce(b.journey_of_board_id, b.id) AND c.user_id = ${principal.userId}
    LEFT JOIN jb_node n ON n.board_id = b.id AND n.id = split_part(x.card_id, ':', 2)
    LEFT JOIN jb_board jy ON jy.journey_of_board_id = b.id AND jy.journey_of_node_id = n.id`.execute(getDb());
  return new Map(rows.map((r) => [r.card_id, {
    cardId: r.card_id, live: r.live && r.kind === 'product-card', kind: r.kind, title: r.title ?? '', boardId: r.board_id, boardName: r.board_name,
    topLevel: r.top_level, journeyBoardId: r.journey_board_id,
    canView: Boolean(r.board_id) && effectiveRights({ isWorkspaceAdmin: principal.isWorkspaceAdmin, isOwner: r.owner_id === principal.userId, collaboratorRole: r.collab_role, workspaceCanEdit: Boolean(r.wce) }).canView,
  }]));
}

/** Union of Features linked on live Product cards inside the given detailed journeys (INT-18). One statement. */
async function featuresInJourneys(journeyBoardIds: string[]) {
  const byBoard = new Map<string, Set<string>>();
  if (!journeyBoardIds.length) return byBoard;
  const bl = await links.linksForBoard({ boardIds: journeyBoardIds, includeJourneys: false, relations: [FEATURE] });
  const live = new Set(bl.cards.map((c) => c.cardId));
  for (const l of bl.links) {
    if (!live.has(l.fromId) || !l.fromScopeId) continue;
    const s = byBoard.get(l.fromScopeId) ?? new Set(); s.add(l.toId); byBoard.set(l.fromScopeId, s);
  }
  return byBoard;
}

export interface SyncResult {
  outcome: 'created' | 'found' | 'renamed';
  journey: JourneyRef; total: number; added: number; removed: number; syncedAt: string;
  sharedBy: { cards: { boardId: string; nodeId: string; title: string; boardName: string }[]; hidden: number };
  message: string;
}

/**
 * INT-15 to INT-25. Steps, each idempotent in its own transaction (ARC-05, INT-24): (1) ensure the Journey in
 * Feedback Hub; (2) assign memberships for the target Journey (with this card) and every Journey left behind
 * (without it); (3) replace the card's Journey link in Core. A failure at any step leaves state that the next run
 * converges from. Statement count is fixed: no scan of boards or cards (D-26, PERF-B19).
 */
export async function journeySync(principal: Principal, boardId: string, nodeId: string): Promise<SyncResult> {
  if (!NODE_RE.test(nodeId)) throw notFound();
  const a = await requireEdit(principal, boardId);
  if (!feedbackHub.hasAccess(principal)) throw new ApiError('forbidden', 'You do not have access to Feedback Hub.', { available: false });
  if (levelOf(a) === 'feature') throw new ApiError('rule_violation', 'Cards in a detailed journey link Features.');
  const cardId = cardIdOf(boardId, nodeId);
  const me = (await cardsInfo(principal, [cardId])).get(cardId);
  if (!me?.live) throw new ApiError('rule_violation', 'Only a live Product card can sync with Feedback Hub.');
  const title = me.title.trim().replace(/\s+/g, ' ');
  if (title.length < 1 || title.length > 120) throw new ApiError('rule_violation', 'Give the card a title of 1 to 120 characters before syncing.');

  const previous = ((await links.listFrom('card', [cardId], [JOURNEY]))[cardId] ?? []).map((l) => l.toId);
  // INT-16: rename the card's current Journey only when no other live card links to it.
  let renameId: string | null = null;
  if (previous.length === 1) {
    const others = ((await links.listTo('journey', previous, [JOURNEY]))[previous[0]] ?? []).map((l) => l.fromId).filter((c) => c !== cardId);
    const info = others.length ? await cardsInfo(principal, others) : new Map<string, CardInfo>();
    if (![...info.values()].some((c) => c.live)) renameId = previous[0];
  }
  const ensured = await feedbackHub.ensureJourneyComponent(principal, { name: title, renameId });
  if ('available' in ensured) throw new ApiError('forbidden', 'You do not have access to Feedback Hub.', { available: false });
  const target = ensured.journey.id;
  const journeys = [target, ...previous.filter((p) => p.toLowerCase() !== target)];

  // INT-18 / INT-20: the cards on each Journey (target with this card, the rest without it), then their journeys' Features.
  const linked = await links.listTo('journey', journeys, [JOURNEY]);
  const cardsOf = new Map(journeys.map((jid) => {
    const ids = new Set((linked[jid] ?? []).map((l) => l.fromId));
    if (jid === target) ids.add(cardId); else ids.delete(cardId);
    return [jid, [...ids]];
  }));
  const info = await cardsInfo(principal, [...new Set([...cardsOf.values()].flat())]);
  const liveTop = (ids: string[]) => ids.map((c) => info.get(c)).filter((c): c is CardInfo => Boolean(c?.live && c.topLevel));
  const byJourneyBoard = await featuresInJourneys([...new Set(liveTop([...info.keys()]).map((c) => c.journeyBoardId).filter((x): x is string => Boolean(x)))]);
  const assignments = journeys.map((jid) => ({
    journeyId: jid,
    featureIds: [...new Set(liveTop(cardsOf.get(jid)!).flatMap((c) => [...(c.journeyBoardId ? byJourneyBoard.get(c.journeyBoardId) ?? [] : [])]))],
  }));
  const assigned = await feedbackHub.assignJourneyIdeas(principal, { assignments });
  if ('available' in assigned) throw new ApiError('forbidden', 'You do not have access to Feedback Hub.', { available: false });
  const res = assigned[target];
  if (!res || res === 'gone') throw new ApiError('conflict', 'The Journey was deleted while syncing. Run the sync again.');

  await links.replaceFrom('jb', { relation: JOURNEY, fromKind: 'card', fromId: cardId, fromScopeId: boardId, toKind: 'journey', toId: target }, principal.userId);
  await notifyBoards([boardId]);

  // INT-18: name only cards the viewer can see; count the rest.
  const shared = liveTop(cardsOf.get(target)!);
  const visible = shared.filter((c) => c.canView).map((c) => ({ boardId: c.boardId!, nodeId: c.cardId.split(':')[1], title: c.title, boardName: c.boardName ?? '' }));
  const verb = ensured.outcome === 'created' ? 'Created' : ensured.outcome === 'renamed' ? 'Renamed to' : 'Synced with';
  const message = `${verb} "${ensured.journey.name}": ${res.total} ${res.total === 1 ? 'idea' : 'ideas'} (${res.added} added, ${res.removed} removed).`
    + (shared.length > 1 ? ` Shared by ${shared.length} cards of this name.` : '');
  return {
    outcome: ensured.outcome, journey: { ...ensured.journey, syncedAt: res.syncedAt, syncedByName: null }, ...res,
    sharedBy: { cards: visible, hidden: shared.length - visible.length }, message,
  };
}

// ── jb.demand.notify (PERF-31, INT-53): Feedback Hub marks what changed; this finds the boards and tells them ──
export async function notifyDemand(): Promise<string[]> {
  const pending = await feedbackHub.pendingDemandChanges();
  if (!pending.featureIds.length && !pending.journeyIds.length) return [];
  const anc = await feedbackHub.featureAncestors(pending.featureIds);
  const features = [...new Set([...pending.featureIds, ...Object.values(anc).flat()])];
  const boards = [
    ...(features.length ? await links.scopesLinkedTo('feature', features) : []),
    ...(pending.journeyIds.length ? await links.scopesLinkedTo('journey', pending.journeyIds) : []),
  ];
  const notified = await notifyBoards(boards);
  await pending.ack();
  return notified;
}

registerJob('jb.demand.notify', async () => { await notifyDemand(); });
