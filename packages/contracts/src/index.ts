// Cross-module types (ARC-04). Types only: no runtime code, no dependencies.
// Adding fields is fine; removing or narrowing one needs a version bump in package.json.

export type Gone = { gone: true };
export type Unavailable = { available: false };

// ── Core links (§6.1 core_link, §9.6) ─────────────────────────────────────
export type LinkRelation = 'maps-to-feature' | 'maps-to-journey' | 'references-card';
export type LinkModule = 'core' | 'fh' | 'jb';

export interface Link {
  id: string;
  relation: LinkRelation;
  fromModule: string; fromKind: string; fromId: string; fromScopeId: string | null;
  toModule: string; toKind: string; toId: string;
  createdBy: string | null;
  createdAt: string;
}

export interface NewLink {
  relation: LinkRelation;
  fromKind: string; fromId: string; fromScopeId: string | null;
  toKind: string; toId: string;
}

/** A board's place in its tree (Journey Boards' published `jb_board_scope` view). */
export interface BoardScope { boardId: string; rootBoardId: string; parentNodeId: string | null }
/** A live Product card (Journey Boards' published `jb_card_scope` view). `cardId` is `<boardId>:<nodeId>`. */
export interface ScopeCard { cardId: string; boardId: string; nodeId: string; title: string }

export interface BoardLinks { scopes: BoardScope[]; cards: ScopeCard[]; links: Link[] }

// ── Feedback Hub (§11.4) ──────────────────────────────────────────────────
export type DemandScope = 'open' | 'all';

export interface FeatureRef { id: string; name: string; depth: number; path: string[]; openCount: number; allCount: number }
export interface JourneyRef { id: string; name: string; syncedAt: string | null; syncedByName: string | null }

export interface SetDemand { count: number; targetDate: string | null; goneFeatureIds: string[] }

export interface DemandResult {
  available: true;
  bySet: Record<string, SetDemand>;
  /** Journey ids asked about that no longer exist (ARC-20). */
  goneJourneyIds: string[];
  /** Filled when `describe` is asked: every Feature id in the sets that still exists. */
  features: Record<string, FeatureRef>;
  /** Filled for `journeyIds` that still exist. */
  journeys: Record<string, JourneyRef>;
}

export interface IdeaRef {
  id: string; number: number; title: string; ideaType: string; status: string | null; bugStatus: string | null;
  dueDate: string | null; updatedAt: string;
}

export interface Breakdown {
  total: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  companyCount: number;
  topCompanies: { id: string; name: string; arr: string | null; ideaCount: number }[];
}

export interface EnsureJourneyResult { journey: JourneyRef; outcome: 'created' | 'found' | 'renamed' }
export interface AssignResult { total: number; added: number; removed: number; syncedAt: string }

// ── Journey Boards (§11.4) ────────────────────────────────────────────────
export interface CardRef { boardId: string; nodeId: string; title: string; kind: string; boardName: string; isJourney: boolean }
