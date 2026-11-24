// D-28 / JB-207 / JB-1306: viewers and commenters get no edit controls (absent, not disabled).
// Renders the real toolbar and details panel with react-dom/server against stores with each right.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BoardProvider, type BoardCtx } from '@/modules/jb/client/context';
import { BoardStore } from '@/modules/jb/client/store';
import { UiStore } from '@/modules/jb/client/ui-store';
import Toolbar from '@/modules/jb/client/ui/Toolbar';
import Panel from '@/modules/jb/client/ui/Panel';
import { statusField } from '@/modules/jb/template';
import type { FieldRec, NodeRec } from '@/modules/jb/ops';

const card: NodeRec = { id: 'c1', kind: 'design-card', x: 0, y: 0, width: null, height: null, zIndex: null, sortKey: 'V',
  data: { title: 'Checkout', owner: 'Ann', fieldValues: { status: 'current' }, links: [{ label: 'Spec', url: 'https://example.com' }] }, version: 1 };

function render(readOnly: boolean, mode: 'collab' | 'share' = 'collab', canComment = false) {
  const store = new BoardStore('client', readOnly);
  store.load({ seq: 1, name: 'B', settings: {}, nodes: [card], edges: [], fields: [{ ...statusField(), version: 1 } as FieldRec] });
  const ui = new UiStore();
  ui.set({ selection: ['c1'] });
  const ctx: BoardCtx = { store, ui, boardId: 'b', mode, me: null, announce: () => {}, requestImages: () => {}, imageUrl: () => undefined };
  const toolbar = renderToStaticMarkup(h(BoardProvider, { value: ctx }, h(Toolbar, {
    side: null, setSide: () => {}, canManage: false, canComment, onPresent: () => {}, onExport: () => {}, centre: () => ({ x: 0, y: 0 }),
  })));
  const panel = renderToStaticMarkup(h(BoardProvider, { value: ctx }, h(Panel, { id: 'c1' })));
  return { toolbar, panel };
}

const EDIT_LABELS = ['Add design card', 'Undo', 'Redo', 'Duplicate', 'Mark reviewed', 'Delete', 'Fields'];

describe('read-only boards show no edit controls (D-28)', () => {
  it('an editor sees the edit controls', () => {
    const { toolbar, panel } = render(false);
    for (const l of EDIT_LABELS) expect(toolbar).toContain(l);
    expect(panel).toContain('<input');
    expect(panel).toContain('Delete card');
  });

  for (const [who, canComment] of [['viewer', false], ['commenter', true]] as const) {
    it(`a ${who} sees none of them, and the panel has no inputs`, () => {
      const { toolbar, panel } = render(true, 'collab', canComment);
      expect(toolbar).not.toContain('data-edit');
      for (const l of EDIT_LABELS) expect(toolbar).not.toContain(`>${l}`);
      expect(panel).not.toMatch(/<(input|select|textarea)/);
      expect(panel).not.toContain('Delete card');
      expect(panel).not.toContain('Mark reviewed');
      expect(panel).toContain('Checkout');
      expect(panel).toContain('View only');
      expect(toolbar).toContain(canComment ? 'Comments' : 'Comments (read)');
    });
  }

  it('share mode has no edit, comment or share controls (JB-1404)', () => {
    const { toolbar, panel } = render(true, 'share');
    expect(toolbar).not.toContain('data-edit');
    expect(toolbar).not.toContain('Comments');
    expect(toolbar).not.toContain('Share');
    expect(panel).not.toMatch(/<(input|select|textarea)/);
  });
});
