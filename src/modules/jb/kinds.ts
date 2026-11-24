// Node kinds registry (JB-301 to JB-306). Pure and shared by the client and the server's op validator.
// Data readers KEEP unknown keys: they only fill defaults and drop wrong shapes (SEC-16, JB-305).
// P5 extension point: the Feedback Hub integration names only `product-card` (JB-302).

export type Carries = 'subtree' | 'members' | 'none';

export interface KindDef {
  id: string;
  label: string;
  canHaveParent: boolean;
  carries: Carries;
  capabilities: { details: boolean; resizable: boolean };
  /** Defaults for a new node of this kind. */
  defaults: () => Record<string, unknown>;
  /** Default size and stacking for new nodes. */
  size?: { width: number; height: number; zIndex?: number };
  /** Counted by statistics widgets and filters (JB-504, JB-601, JB-1001). */
  isDesignCard?: boolean;
}

export const SECTION_COLOURS = ['gray', 'blue', 'violet', 'green', 'amber', 'rose', 'cyan', 'lime'] as const;
export const TEXT_SIZES = ['s', 'm', 'l', 'xl'] as const;
export const TEXT_FONTS = ['sans', 'serif', 'mono'] as const;

const kinds = new Map<string, KindDef>();

export function registerKind(def: KindDef) {
  if (!/^[a-z][a-z0-9-]*$/.test(def.id)) throw new Error(`bad kind id ${def.id}`);
  if (kinds.has(def.id)) throw new Error(`kind ${def.id} registered twice`); // a kind is never replaced
  kinds.set(def.id, def);
}

export const getKind = (id: string): KindDef | undefined => kinds.get(id);
export const isRegisteredKind = (id: string) => kinds.has(id);
export const allKinds = (): KindDef[] => [...kinds.values()];

registerKind({
  id: 'design-card', label: 'Design card', canHaveParent: true, carries: 'subtree', isDesignCard: true,
  capabilities: { details: true, resizable: false },
  defaults: () => ({
    title: 'Untitled', description: '', area: '', versionTag: '', owner: '', team: '', contributors: [],
    excludeFromStats: false, fieldValues: {}, parentId: null, collapsed: false, cardSize: 'normal',
    currentVersion: { designUrl: '', prototypeUrl: '', docUrl: '' }, comparison: {}, changeSummary: {},
    links: [], versionHistory: [],
  }),
});

registerKind({
  id: 'product-card', label: 'Product card', canHaveParent: false, carries: 'none',
  capabilities: { details: true, resizable: false },
  defaults: () => ({ title: 'Untitled product', description: '', owner: '', journeyStage: '', status: '', links: [] }),
});

registerKind({
  id: 'section', label: 'Section', canHaveParent: false, carries: 'members',
  capabilities: { details: false, resizable: true },
  size: { width: 480, height: 320, zIndex: -10 },
  defaults: () => ({ label: 'Section', color: 'gray' }),
});

registerKind({
  id: 'text', label: 'Text', canHaveParent: false, carries: 'none',
  capabilities: { details: false, resizable: false },
  defaults: () => ({ text: 'Text', size: 'm', color: 'gray', font: 'sans', bold: false }),
});

registerKind({
  id: 'stats', label: 'Statistics', canHaveParent: false, carries: 'none',
  capabilities: { details: false, resizable: false },
  defaults: () => ({ scope: { type: 'board' }, attributeId: 'status', goalOptionId: 'current', excludedOptionIds: ['deprecated'], includeSubItems: true }),
});

// ── defensive readers (SEC-16) ─────────────────────────────────────────────
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const bool = (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : d);

export interface DesignCardView {
  title: string; description: string; area: string; versionTag: string; owner: string; team: string;
  excludeFromStats: boolean; fieldValues: Record<string, unknown>; parentId: string | null; collapsed: boolean;
  cardSize: 'normal' | 'large'; updatedAt: string | null; reviewedAt: string | null; reviewedBy: string | null;
  links: { label: string; url: string }[]; comparison: { previousImageId?: string; currentImageId?: string; previousLabel?: string; currentLabel?: string };
  changeSummary: Record<string, string>; currentVersion: { designUrl: string; prototypeUrl: string; docUrl: string };
}

export function readLinks(v: unknown): { label: string; url: string }[] {
  if (!Array.isArray(v)) return [];
  return v.filter((l) => l && typeof l === 'object').map((l) => ({ label: str((l as Record<string, unknown>).label), url: str((l as Record<string, unknown>).url) }));
}

export function readDesignCard(d: Record<string, unknown>): DesignCardView {
  const fv = d.fieldValues && typeof d.fieldValues === 'object' && !Array.isArray(d.fieldValues) ? d.fieldValues as Record<string, unknown> : {};
  const cmp = d.comparison && typeof d.comparison === 'object' ? d.comparison as Record<string, unknown> : {};
  const cs = d.changeSummary && typeof d.changeSummary === 'object' ? d.changeSummary as Record<string, unknown> : {};
  const cv = d.currentVersion && typeof d.currentVersion === 'object' ? d.currentVersion as Record<string, unknown> : {};
  return {
    title: str(d.title, 'Untitled'), description: str(d.description), area: str(d.area), versionTag: str(d.versionTag),
    owner: str(d.owner), team: str(d.team), excludeFromStats: bool(d.excludeFromStats), fieldValues: fv,
    parentId: typeof d.parentId === 'string' && d.parentId ? d.parentId : null, collapsed: bool(d.collapsed),
    cardSize: d.cardSize === 'large' ? 'large' : 'normal',
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : null,
    reviewedAt: typeof d.reviewedAt === 'string' ? d.reviewedAt : null,
    reviewedBy: typeof d.reviewedBy === 'string' ? d.reviewedBy : null,
    links: readLinks(d.links),
    comparison: {
      previousImageId: typeof cmp.previousImageId === 'string' ? cmp.previousImageId : undefined,
      currentImageId: typeof cmp.currentImageId === 'string' ? cmp.currentImageId : undefined,
      previousLabel: typeof cmp.previousLabel === 'string' ? cmp.previousLabel : undefined,
      currentLabel: typeof cmp.currentLabel === 'string' ? cmp.currentLabel : undefined,
    },
    changeSummary: Object.fromEntries(Object.entries(cs).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
    currentVersion: { designUrl: str(cv.designUrl), prototypeUrl: str(cv.prototypeUrl), docUrl: str(cv.docUrl) },
  };
}

export function readProductCard(d: Record<string, unknown>) {
  return {
    title: str(d.title, 'Untitled product'), description: str(d.description), owner: str(d.owner),
    journeyStage: str(d.journeyStage), status: str(d.status), links: readLinks(d.links),
  };
}

export function readSection(d: Record<string, unknown>) {
  const color = (SECTION_COLOURS as readonly string[]).includes(d.color as string) ? d.color as string : 'gray';
  return { label: str(d.label, 'Section'), color };
}

export function readText(d: Record<string, unknown>) {
  return {
    text: str(d.text), size: (TEXT_SIZES as readonly string[]).includes(d.size as string) ? d.size as string : 'm',
    color: (SECTION_COLOURS as readonly string[]).includes(d.color as string) ? d.color as string : 'gray',
    font: (TEXT_FONTS as readonly string[]).includes(d.font as string) ? d.font as string : 'sans', bold: bool(d.bold),
  };
}

export function readStats(d: Record<string, unknown>) {
  const scope = d.scope && typeof d.scope === 'object' ? d.scope as Record<string, unknown> : { type: 'board' };
  return {
    scope: { type: scope.type === 'section' || scope.type === 'selection' ? scope.type as string : 'board', sectionId: str(scope.sectionId), nodeIds: Array.isArray(scope.nodeIds) ? scope.nodeIds.filter((x) => typeof x === 'string') as string[] : [] },
    attributeId: str(d.attributeId, 'status'), goalOptionId: str(d.goalOptionId, 'current'),
    excludedOptionIds: Array.isArray(d.excludedOptionIds) ? d.excludedOptionIds.filter((x) => typeof x === 'string') as string[] : [],
    includeSubItems: bool(d.includeSubItems, true),
  };
}
