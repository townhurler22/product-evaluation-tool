// NFR-15: op apply, invert and rebase; fractional sort keys; rights; derived layers.
import { describe, expect, it } from 'vitest';
import {
  applyOp, emptyDoc, foldInto, invertOp, mergeData, rebase, stampBaseVersions, validSequence, withoutKeys, opKeys,
  type NodeRec, type Op,
} from '@/modules/jb/ops';
import { keyBetween, keysAfter, spreadKeys, isSortKey } from '@/modules/jb/sortkey';
import { effectiveRights, canShareOutward } from '@/modules/jb/rights';
import { boardHealth, computeStats, dayNumber, freshness, lookahead, matchesFilters, emptyFilters, wouldCycle, readiness } from '@/modules/jb/derive';
import { readDesignCard } from '@/modules/jb/kinds';
import { statusField } from '@/modules/jb/template';
import { sanitizeText, safeUrl, cleanText } from '@/lib/text';

const node = (id: string, data: Record<string, unknown> = {}, extra: Partial<NodeRec> = {}): NodeRec =>
  ({ id, kind: 'design-card', x: 0, y: 0, width: null, height: null, zIndex: null, sortKey: 'V', data: { title: id, ...data }, version: 1, ...extra });
const docWith = (...nodes: NodeRec[]) => { const d = emptyDoc(); for (const n of nodes) d.nodes.set(n.id, n); return d; };

describe('ops', () => {
  it('apply then inverse restores the doc exactly (patch, delete, create, board)', () => {
    const d = docWith(node('a', { owner: 'Ann', fieldValues: { status: 'current' } }));
    d.settings = { x: 1 };
    const before = structuredClone([...d.nodes.values()]);
    const ops: Op[] = [
      { type: 'node', op: 'patch', id: 'a', set: { x: 5 }, data: { owner: 'Bo', area: 'New', 'fieldValues.status': 'legacy' }, unset: ['title'] },
      { type: 'board', op: 'patch', name: 'N', settings: { x: 2, y: 3 } },
    ];
    const inv = ops.map((o) => { const i = invertOp(d, o)!; applyOp(d, o); return i; }).reverse();
    expect(d.nodes.get('a')!.data).toMatchObject({ owner: 'Bo', area: 'New', fieldValues: { status: 'legacy' } });
    for (const i of inv) applyOp(d, i);
    expect([...d.nodes.values()].map((n) => ({ ...n, version: 1 }))).toEqual(before);
    expect(d.settings).toEqual({ x: 1 });
    const del: Op = { type: 'node', op: 'delete', id: 'a' };
    const undoDel = invertOp(d, del)!;
    applyOp(d, del);
    expect(d.nodes.has('a')).toBe(false);
    applyOp(d, undoDel);
    expect(d.nodes.get('a')!.data.owner).toBe('Ann');
  });

  it('mergeData: one level deep, fieldValues one deeper, null is a value', () => {
    expect(mergeData({ a: 1, fieldValues: { s: 'x', t: 'y' } }, { b: null, 'fieldValues.s': 'z' }, ['a', 'fieldValues.t']))
      .toEqual({ b: null, fieldValues: { s: 'z' } });
  });

  it('folds patches into creates and patches; delete after create and restore after delete cancel (JB-1603)', () => {
    let l: Op[] = [];
    l = foldInto(l, { type: 'node', op: 'create', id: 'a', value: { kind: 'design-card', x: 0, y: 0, sortKey: 'V', data: { title: 'A' } } });
    l = foldInto(l, { type: 'node', op: 'patch', id: 'a', set: { x: 9 }, data: { title: 'B' } });
    expect(l).toEqual([{ type: 'node', op: 'create', id: 'a', value: { kind: 'design-card', x: 9, y: 0, sortKey: 'V', data: { title: 'B' } } }]);
    l = foldInto(l, { type: 'node', op: 'delete', id: 'a' });
    expect(l).toEqual([]);
    l = foldInto(l, { type: 'node', op: 'patch', id: 'b', data: { a: 1 } });
    l = foldInto(l, { type: 'node', op: 'patch', id: 'b', unset: ['a'], data: { c: 2 } });
    expect(l).toEqual([{ type: 'node', op: 'patch', id: 'b', data: { c: 2 }, unset: ['a'] }]);
    l = foldInto(l, { type: 'node', op: 'delete', id: 'b' });
    l = foldInto(l, { type: 'node', op: 'restore', id: 'b' });
    expect(l).toEqual([{ type: 'node', op: 'patch', id: 'b', data: { c: 2 }, unset: ['a'] }]);
    expect(validSequence(['create', 'patch', 'delete'])).toBe(true);
    expect(validSequence(['delete', 'restore'])).toBe(false);
    expect(validSequence(['patch', 'create'])).toBe(false);
  });

  it('fine-grained keys and key stripping (JB-1703)', () => {
    const op: Op = { type: 'node', op: 'patch', id: 'a', set: { x: 1, y: 2, width: 3 }, data: { title: 't', 'fieldValues.s': 1 } };
    expect(opKeys(op)).toEqual(['node:a:position', 'node:a:position', 'node:a:size', 'node:a:data.title', 'node:a:fieldValues.s']);
    expect(withoutKeys(op, new Set(['node:a:position', 'node:a:data.title']))).toEqual({ type: 'node', op: 'patch', id: 'a', set: { width: 3 }, data: { 'fieldValues.s': 1 } });
    expect(withoutKeys({ type: 'node', op: 'delete', id: 'a' }, new Set(['node:a:exists']))).toBeNull();
  });

  it('rebase keeps ops on live objects and drops ops on objects deleted remotely (JB-1605)', () => {
    const server = docWith(node('live'));
    const { ops, dropped } = rebase([
      { type: 'node', op: 'patch', id: 'live', data: { a: 1 } },
      { type: 'node', op: 'patch', id: 'gone', data: { a: 1 } },
      { type: 'node', op: 'create', id: 'new', value: { kind: 'text', x: 0, y: 0, sortKey: 'V', data: {} } },
      { type: 'node', op: 'patch', id: 'new', data: { a: 1 } },
    ], server);
    expect(ops.map((o) => (o as { id: string }).id)).toEqual(['live', 'new', 'new']);
    expect(dropped).toBe(1);
    server.nodes.get('live')!.version = 7;
    expect(stampBaseVersions(ops, server).map((o) => (o as { baseVersion?: number }).baseVersion)).toEqual([7, undefined, undefined]);
  });
});

describe('sort keys', () => {
  it('always fit between, in byte order, never ending in 0', () => {
    let a: string | null = null; const keys: string[] = [];
    for (let i = 0; i < 200; i++) { a = keyBetween(a, null); keys.push(a); }
    expect([...keys].sort()).toEqual(keys);
    const m = keyBetween('V', 'W');
    expect(m > 'V' && m < 'W' && isSortKey(m)).toBe(true);
    const spread = spreadKeys(2000);
    expect([...spread].sort()).toEqual(spread);
    expect(new Set(spread).size).toBe(2000);
    expect(spread.every(isSortKey)).toBe(true);
    expect(keysAfter('V', 3).every((k) => k > 'V')).toBe(true);
  });
});

describe('effective rights (§8.13)', () => {
  const r = (o: Partial<Parameters<typeof effectiveRights>[0]>) => effectiveRights({ isWorkspaceAdmin: false, isOwner: false, collaboratorRole: null, workspaceCanEdit: false, ...o });
  it('matches the table', () => {
    expect(r({ isWorkspaceAdmin: true })).toMatchObject({ role: 'manager', canManage: true });
    expect(r({ isOwner: true })).toMatchObject({ role: 'owner', canManage: true });
    expect(r({ collaboratorRole: 'EDITOR' })).toMatchObject({ canEdit: true, canManage: false });
    expect(r({ collaboratorRole: 'COMMENTER' })).toMatchObject({ canEdit: false, canComment: true });
    expect(r({ collaboratorRole: 'COMMENTER', workspaceCanEdit: true })).toMatchObject({ canEdit: true });
    expect(r({ collaboratorRole: 'VIEWER' })).toMatchObject({ canView: true, canEdit: false, canComment: false });
    expect(r({ collaboratorRole: 'VIEWER', workspaceCanEdit: true })).toMatchObject({ canEdit: true, canComment: true, canManage: false });
    expect(r({ workspaceCanEdit: true })).toMatchObject({ role: 'workspace', canEdit: true, canManage: false });
    expect(r({})).toMatchObject({ role: 'none', canView: false });
    expect(canShareOutward({ isWorkspaceAdmin: false, isOwner: false, collaboratorRole: null, workspaceCanEdit: true })).toBe(false);
  });
});

describe('derived layers (§8.10, §8.11)', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  const t = { agingDays: 30, staleDays: 90 };
  it('freshness uses reviewedAt, else updatedAt', () => {
    expect(freshness(readDesignCard({}), now, t)).toBe('never');
    expect(freshness(readDesignCard({ updatedAt: '2026-11-20T00:00:00Z' }), now, t)).toBe('fresh');
    expect(freshness(readDesignCard({ updatedAt: '2026-09-01T00:00:00Z' }), now, t)).toBe('aging');
    expect(freshness(readDesignCard({ updatedAt: '2026-01-01T00:00:00Z', reviewedAt: '2026-11-23T00:00:00Z' }), now, t)).toBe('fresh');
    expect(freshness(readDesignCard({ updatedAt: '2026-01-01T00:00:00Z' }), now, t)).toBe('stale');
  });
  it('calendar dates never pass through a time zone (JB-903) and lookahead buckets', () => {
    const today = dayNumber('2026-11-24')!;
    expect(lookahead('2026-11-23', today, 4)).toBe('overdue');
    expect(lookahead('2026-11-30', today, 4)).toBe('this-week');
    expect(lookahead('2026-12-01', today, 4)).toBe('next-week');
    expect(lookahead('2026-12-20', today, 4)).toBe('soon');
    expect(lookahead('2027-03-01', today, 4)).toBe('later');
    expect(lookahead(undefined, today, 4)).toBe('none');
    expect(readiness(readDesignCard({ fieldValues: { d: '2026-11-01', status: 'legacy' } }), 'd', today, 4)).toBe('overdue');
    expect(readiness(readDesignCard({ fieldValues: { d: '2026-12-01', status: 'current' } }), 'd', today, 4)).toBe('at-risk'); // no owner
  });
  it('health rows, filters (Design cards only), statistics', () => {
    const nodes = [node('a', { owner: 'A', fieldValues: { status: 'current' }, reviewedAt: now.toISOString(), links: [{ label: 'x', url: 'https://x' }] }),
      node('b', { fieldValues: { status: 'deprecated' } }), node('c', {}), node('p', {}, { kind: 'product-card' })];
    const h = boardHealth(nodes, statusField() as never, now, t);
    expect(h.noOwner).toEqual(['b', 'c']);
    expect(h.never).toEqual(['b', 'c']);
    expect(h.notAssessed).toEqual(['c']);
    const f = { ...emptyFilters(), options: { status: ['current'] } };
    expect(nodes.map((n) => matchesFilters(n, f, now, t))).toEqual([true, false, false, true]);
    const s = computeStats(nodes, statusField() as never, 'current', ['deprecated']);
    expect([s.total, s.goalPct]).toEqual([1, 100]);
    const byId = (id: string) => nodes.find((n) => n.id === id);
    nodes[0].data.parentId = 'b'; nodes[1].data.parentId = null;
    expect(wouldCycle('b', 'a', byId)).toBe(true);
    expect(wouldCycle('c', 'a', byId)).toBe(false);
  });
});

describe('sanitiser (SEC-13, SEC-15)', () => {
  it('strips controls, bidi and zero-width, normalises, never truncates', () => {
    expect(sanitizeText(' a‮b​c\r\n\n\n\nd\u0007 ')).toBe('abc\n\nd');
    expect(sanitizeText('   ')).toBeNull();
    expect(() => cleanText('abcd', 3)).toThrow();
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('https://u:p@x.com')).toBeNull();
    expect(safeUrl('https://x.com/a')).toBe('https://x.com/a');
  });
});
