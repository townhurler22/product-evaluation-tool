// Built-in content: the Design status field (JB-901), field presets (JB-902) and the sample
// "product map" template (JB-1903). Pure, so the server and tests share it.
import { STATUS_OPTIONS } from './derive';
import type { EdgeRec, FieldRec, NodeRec } from './ops';
import { spreadKeys } from './sortkey';

type NewField = Omit<FieldRec, 'version'>;
type NewNode = Omit<NodeRec, 'version'>;
type NewEdge = Omit<EdgeRec, 'version'>;

export function statusField(sortKey = 'V'): NewField {
  return {
    id: 'status', kind: 'picker', label: 'Design status', options: STATUS_OPTIONS.map((o) => ({ ...o })), showOnCard: true,
    sortKey, presetKey: 'status', extra: {},
  };
}

export const FIELD_PRESETS: Record<string, Omit<NewField, 'id' | 'sortKey'>> = {
  'dev-version': { kind: 'picker', label: 'Dev version state', showOnCard: false, presetKey: 'dev-version', extra: {},
    options: [{ id: 'not-started', label: 'Not started', colour: 'gray' }, { id: 'in-dev', label: 'In development', colour: 'blue' }, { id: 'shipped', label: 'Shipped', colour: 'green' }] },
  'product-priority': { kind: 'picker', label: 'Product priority', showOnCard: true, presetKey: 'product-priority', extra: {},
    options: [{ id: 'p1', label: 'High', colour: 'rose' }, { id: 'p2', label: 'Medium', colour: 'amber' }, { id: 'p3', label: 'Low', colour: 'gray' }] },
  'design-type': { kind: 'picker', label: 'Design type', showOnCard: false, presetKey: 'design-type', extra: {},
    options: [{ id: 'screen', label: 'Screen', colour: 'blue' }, { id: 'flow', label: 'Flow', colour: 'violet' }, { id: 'component', label: 'Component', colour: 'cyan' }] },
  'design-needed-by': { kind: 'date', label: 'Design needed by', showOnCard: true, presetKey: 'design-needed-by', extra: {}, options: [] },
  'dev-hand-off': { kind: 'date', label: 'Dev hand-off', showOnCard: false, presetKey: 'dev-hand-off', extra: {}, options: [] },
};

const isoDay = (base: Date, addDays: number) => new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + addDays)).toISOString().slice(0, 10);
const isoAgo = (base: Date, days: number) => new Date(base.getTime() - days * 86_400_000).toISOString();

/** The sample product map. Everything is relative to `now`, so freshness and lookahead show every state. */
export function sampleTemplate(now: Date): { fields: NewField[]; nodes: NewNode[]; edges: NewEdge[]; settings: Record<string, unknown> } {
  const fk = spreadKeys(2);
  const fields: NewField[] = [statusField(fk[0]), { id: 'needed-by', sortKey: fk[1], ...FIELD_PRESETS['design-needed-by'] }];
  const card = (id: string, x: number, y: number, title: string, area: string, owner: string, status: string, updatedDaysAgo: number, extra: Record<string, unknown> = {}) => ({
    id, kind: 'design-card', x, y, width: null, height: null, zIndex: null,
    data: { title, description: '', area, versionTag: 'v1', owner, team: 'Product design', contributors: [], excludeFromStats: false,
      fieldValues: { status, ...(extra.neededBy ? { 'needed-by': extra.neededBy } : {}) }, parentId: extra.parentId ?? null, collapsed: false,
      cardSize: 'normal', currentVersion: { designUrl: extra.designUrl ?? '', prototypeUrl: '', docUrl: '' }, comparison: {}, changeSummary: {},
      links: [], versionHistory: [], updatedAt: isoAgo(now, updatedDaysAgo), ...(extra.reviewedDaysAgo !== undefined ? { reviewedAt: isoAgo(now, extra.reviewedDaysAgo as number), reviewedBy: 'Sample' } : {}) },
  });
  const raw = [
    { id: 'sec-onboarding', kind: 'section', x: 0, y: 0, width: 1100, height: 520, zIndex: -10, data: { label: 'Onboarding', color: 'blue' } },
    { id: 'sec-checkout', kind: 'section', x: 1200, y: 0, width: 820, height: 520, zIndex: -10, data: { label: 'Checkout', color: 'green' } },
    { id: 'title', kind: 'text', x: 0, y: -110, width: null, height: null, zIndex: null, data: { text: 'Sample product map', size: 'xl', color: 'gray', font: 'sans', bold: true } },
    card('dc-signup', 40, 60, 'Sign up', 'Onboarding', 'Alex', 'current', 5, { reviewedDaysAgo: 2, designUrl: 'https://example.com/designs/sign-up', neededBy: isoDay(now, -3) }),
    card('dc-verify', 40, 260, 'Verify email', '', 'Alex', 'redesign', 45, { parentId: 'dc-signup', neededBy: isoDay(now, 4) }),
    card('dc-profile', 320, 260, 'Create profile', '', '', 'not-assessed', 120, { parentId: 'dc-signup', neededBy: isoDay(now, 10) }),
    card('dc-tour', 600, 60, 'Product tour', 'Onboarding', 'Sam', 'legacy', 200, {}),
    { id: 'pc-onboarding', kind: 'product-card', x: 820, y: 300, width: null, height: null, zIndex: null,
      data: { title: 'Onboarding journey', description: 'From sign-up to first value.', owner: 'Priya', journeyStage: 'Activation', status: 'current', links: [] } },
    card('dc-cart', 1240, 60, 'Cart', 'Checkout', 'Jo', 'current', 12, { reviewedDaysAgo: 1, neededBy: isoDay(now, 20) }),
    card('dc-pay', 1240, 260, 'Payment', 'Checkout', 'Jo', 'redesign', 60, { neededBy: isoDay(now, 40) }),
    card('dc-receipt', 1520, 260, 'Receipt', 'Checkout', '', 'deprecated', 95, {}),
    { id: 'stats', kind: 'stats', x: 1520, y: 40, width: null, height: null, zIndex: null,
      data: { scope: { type: 'board' }, attributeId: 'status', goalOptionId: 'current', excludedOptionIds: ['deprecated'], includeSubItems: true } },
  ];
  const keys = spreadKeys(raw.length);
  const nodes = raw.map((n, i) => ({ ...n, parentId: (n.data as { parentId?: string | null }).parentId ?? null, sortKey: keys[i] })) as (NewNode & { parentId: string | null })[];
  const ek = spreadKeys(3);
  const edges: NewEdge[] = [
    { id: 'e-tour-product', source: 'dc-tour', target: 'pc-onboarding', sortKey: ek[0], data: { label: 'part of', directed: true } },
    { id: 'e-signup-tour', source: 'dc-signup', target: 'dc-tour', sortKey: ek[1], data: { label: '', directed: true } },
    { id: 'e-cart-pay', source: 'dc-cart', target: 'dc-pay', sortKey: ek[2], data: { label: 'then', directed: true } },
  ];
  return { fields, nodes, edges, settings: { lookahead: { fieldId: 'needed-by', horizonWeeks: 4 }, health: { agingDays: 30, staleDays: 90 } } };
}
