// Feedback Hub pure rules (NFR-15): status machine and type remap, Prio-Value, view predicates, dates and release
// train, sanitiser, Markdown, CSV, timeline geometry, layout reconcile.
import { describe, expect, it } from 'vitest';
import {
  allowedTargets, canTransition, estimateFor, isOpenDemand, matchesView, prioValue, releaseTrainDates, remapForType,
  roadmapDefaults, STATUS_KEYS, statusKeyOf, statusLabel, BULK_CHUNK,
} from '@/modules/fh/domain';
import { csvCell, csvRow, parseInline, parseMarkdown, safeUrl, sanitise } from '@/modules/fh/text';
import { barGeometry, initialWindowStart, panStep, snapDays, ticks } from '@/modules/fh/timeline';
import { reconcileLayout, nextSort, defaultLayout } from '@/app/fh/_lib/layout';
import { COLUMNS } from '@/modules/fh/columns';
import { BulkIds } from '@/modules/fh/schemas';

describe('status machine (FH-302, FH-307)', () => {
  it('allows the listed transitions and same-status no-ops, and nothing across workflows', () => {
    expect(canTransition('IDEA_BACKLOG', 'IDEA_COMPLETE')).toBe(false);
    expect(canTransition('IDEA_BACKLOG', 'IDEA_PLANNED')).toBe(true);
    expect(canTransition('BUG_FIXED', 'BUG_OPEN')).toBe(false);
    expect(canTransition('BUG_RELEASED', 'BUG_OPEN')).toBe(true);
    expect(canTransition('IDEA_OPEN', 'IDEA_OPEN')).toBe(true);
    for (const k of STATUS_KEYS) for (const t of allowedTargets(k)) expect(t.slice(0, 3)).toBe(k.slice(0, 3));
    expect(allowedTargets('IDEA_OPEN')).toHaveLength(7);
  });

  it('remaps status on type change both ways; same family keeps status', () => {
    expect(remapForType({ ideaType: 'IMPROVEMENT', status: 'PLANNED', bugStatus: null }, 'BUG')).toEqual({ status: null, bugStatus: 'TRIAGED' });
    expect(remapForType({ ideaType: 'IMPROVEMENT', status: 'COMPLETE', bugStatus: null }, 'BUG')).toEqual({ status: null, bugStatus: 'RELEASED' });
    expect(remapForType({ ideaType: 'BUG', status: null, bugStatus: 'FIXED' }, 'FEATURE_REQUEST')).toEqual({ status: 'IN_PROGRESS', bugStatus: null });
    expect(remapForType({ ideaType: 'BUG', status: null, bugStatus: 'CANNOT_REPRODUCE' }, 'QUESTION')).toEqual({ status: 'CLOSED', bugStatus: null });
    expect(remapForType({ ideaType: 'IMPROVEMENT', status: 'BACKLOG', bugStatus: null }, 'INITIATIVE')).toEqual({ status: 'BACKLOG', bugStatus: null });
  });

  it('a row that breaks the shape reads as "No status" (FH-309)', () => {
    expect(statusKeyOf({ status: 'OPEN', bugStatus: 'OPEN' })).toBeNull();
    expect(statusLabel(null)).toBe('No status');
    expect(statusLabel('BUG_IN_DEV', true)).toBe('Bug · In development');
  });

  it('open demand counts a Fixed bug and excludes finished work (§5.2)', () => {
    expect(isOpenDemand('BUG_FIXED')).toBe(true);
    expect(isOpenDemand('BUG_CANNOT_REPRODUCE')).toBe(false);
    expect(isOpenDemand('IDEA_COMPLETE')).toBe(false);
    expect(isOpenDemand('IDEA_PLANNED')).toBe(true);
  });
});

describe('Prio-Value (FH-312)', () => {
  it('is blank unless all five are scored; spans 1 to 10', () => {
    expect(prioValue({ strategicValue: 5, revenueImpact: 5, customerExperience: 5, riskScore: 5, effortScore: null })).toBeNull();
    expect(prioValue({ strategicValue: 10, revenueImpact: 10, customerExperience: 10, riskScore: 1, effortScore: 1 })).toBe(10);
    expect(prioValue({ strategicValue: 1, revenueImpact: 1, customerExperience: 1, riskScore: 10, effortScore: 10 })).toBe(1);
    expect(prioValue({ strategicValue: 7, revenueImpact: 4, customerExperience: 6, riskScore: 3, effortScore: 5 })).toBe(5.8);
  });
});

describe('views and dates (FH-101, FH-305, FH-766, FH-767)', () => {
  it('view predicates', () => {
    expect(matchesView('triage', { status: null, bugStatus: 'OPEN', startDate: null })).toBe(true);
    expect(matchesView('backlog', { status: null, bugStatus: 'TRIAGED', startDate: null })).toBe(true);
    expect(matchesView('roadmap', { status: 'PLANNED', bugStatus: null, startDate: null })).toBe(false);
    expect(matchesView('roadmap', { status: null, bugStatus: 'FIXED', startDate: '2026-01-01' })).toBe(true);
    expect(matchesView('board', { status: 'CLOSED', bugStatus: null, startDate: null })).toBe(true);
  });

  it('entering a roadmap status sets start today and due start + 7 only when start is empty', () => {
    const now = new Date('2026-11-24T23:30:00Z');
    expect(roadmapDefaults('IDEA_PLANNED', { startDate: null, dueDate: null }, now)).toEqual({ startDate: '2026-11-24', dueDate: '2026-12-01' });
    expect(roadmapDefaults('IDEA_PLANNED', { startDate: null, dueDate: '2026-12-20' }, now)).toEqual({ startDate: '2026-11-24', dueDate: '2026-12-20' });
    expect(roadmapDefaults('IDEA_PLANNED', { startDate: '2026-01-01', dueDate: null }, now)).toEqual({ startDate: '2026-01-01', dueDate: null });
    expect(roadmapDefaults('IDEA_BACKLOG', { startDate: null, dueDate: null }, now)).toEqual({ startDate: null, dueDate: null });
  });

  it('estimate = max(1, days between) and release trains run both ways from the anchor (OD-33)', () => {
    expect(estimateFor('2026-01-01', '2026-01-01')).toBe(1);
    expect(estimateFor('2026-01-01', '2026-01-11')).toBe(10);
    expect(releaseTrainDates('2026-01-05', 21, '2025-12-01', '2026-02-20')).toEqual(['2025-12-15', '2026-01-05', '2026-01-26', '2026-02-16']);
  });
});

describe('timeline geometry (FH-762–766)', () => {
  it('opens each zoom where the spec says (OD-15: first day of the current month for 6 months)', () => {
    expect(initialWindowStart('2w', '2026-11-24', 5)).toBe('2026-11-21');
    expect(initialWindowStart('6m', '2026-11-24', 5)).toBe('2026-11-01');
    expect(initialWindowStart('1y', '2026-11-24', 5)).toBe('2026-05-01');
    expect(initialWindowStart('1y', '2026-03-02', 5)).toBe('2025-05-01');
    expect(panStep('8w')).toBe(14);
  });

  it('bars are inclusive, clipped bars are marked, bars outside are not drawn; drags snap', () => {
    expect(barGeometry('2026-01-05', '2026-01-05', '2026-01-01', 14, 10)).toEqual({ left: 40, width: 10, clippedStart: false, clippedEnd: false });
    expect(barGeometry('2025-12-30', '2026-01-02', '2026-01-01', 14, 10)).toEqual({ left: 0, width: 20, clippedStart: true, clippedEnd: false });
    expect(barGeometry('2026-02-01', null, '2026-01-01', 14, 10)).toBeNull();
    expect(snapDays(26, 10)).toBe(3);
    expect(snapDays(26, 2)).toBe(14);
    expect(ticks('8w', '2026-11-23').length).toBe(8);
  });
});

describe('sanitiser, Markdown and links (SEC-13–15)', () => {
  it('strips controls, bidi and zero-width characters, normalises newlines, trims; empty is null', () => {
    expect(sanitise(' a\u0000b‮c​d\r\n\r\n\r\n\r\ne\u0007 ')).toBe('abcd\n\ne');
    expect(sanitise('Café')).toBe('Café');
    expect(sanitise(' ​ ')).toBeNull();
    expect(sanitise('tab\there')).toBe('tab\there');
  });

  it('accepts http(s) links only, without credentials', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('https://user:pw@example.com')).toBeNull();
    expect(safeUrl('x'.repeat(2001))).toBeNull();
  });

  it('parses limited Markdown into spans, never HTML', () => {
    expect(parseInline('**bold** and _it_ `code` https://x.test/a.')).toEqual([
      { t: 'b', c: [{ t: 'text', v: 'bold' }] }, { t: 'text', v: ' and ' }, { t: 'i', c: [{ t: 'text', v: 'it' }] },
      { t: 'text', v: ' ' }, { t: 'code', v: 'code' }, { t: 'text', v: ' ' }, { t: 'link', href: 'https://x.test/a', v: 'https://x.test/a' }, { t: 'text', v: '.' },
    ]);
    expect(parseMarkdown('<script>x</script>\n\n- a\n- b')).toEqual([
      { t: 'p', c: [{ t: 'text', v: '<script>x</script>' }] }, { t: 'ul', items: [[{ t: 'text', v: 'a' }], [{ t: 'text', v: 'b' }]] },
    ]);
  });
});

describe('CSV writer (SEC-18)', () => {
  it('neutralises formulas in text cells only', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('\rx')).toBe("\"'\rx\"");
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell(-5, true)).toBe('-5');
    expect(csvCell('-12.50', true)).toBe('-12.50');
    expect(csvRow(['a', 'b'])).toBe('a,b\r\n');
  });
});

describe('column layout (FH-111)', () => {
  it('drops unknown columns and inserts new ones after their canonical predecessor', () => {
    const l = reconcileLayout({ order: ['title', 'gone', 'number'], hidden: ['gone', 'status'], widths: { title: 10, gone: 5 }, sort: { column: 'nope', dir: 'asc' } });
    expect(l.order).not.toContain('gone');
    expect(l.order).toHaveLength(COLUMNS.length);
    expect(l.order.slice(0, 3)).toEqual(['title', 'triage', 'source']);
    expect(l.hidden).toEqual(['status']);
    expect(l.widths).toEqual({ title: 56 });
    expect(l.sort).toBeNull();
    expect(reconcileLayout(null)).toEqual(defaultLayout());
  });

  it('header clicks cycle ascending, descending, off (FH-110)', () => {
    expect(nextSort(null, 'arr')).toEqual({ column: 'arr', dir: 'asc' });
    expect(nextSort({ column: 'arr', dir: 'asc' }, 'arr')).toEqual({ column: 'arr', dir: 'desc' });
    expect(nextSort({ column: 'arr', dir: 'desc' }, 'arr')).toBeNull();
  });
});

describe('bulk cap', () => {
  it('the client chunk size equals the server cap (FH-154)', () => {
    expect(BULK_CHUNK).toBe(200);
    const id = '0190c3a0-0000-7000-8000-000000000001';
    expect(BulkIds.safeParse(Array(BULK_CHUNK).fill(id)).success).toBe(true);
    expect(BulkIds.safeParse(Array(BULK_CHUNK + 1).fill(id)).success).toBe(false);
  });
});
