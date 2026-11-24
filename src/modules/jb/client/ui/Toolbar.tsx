'use client';
// Board toolbar (JB-202, JB-206). JB-207 / D-28: every mutating control is ABSENT, not disabled,
// when the board is read-only for this viewer, in presentation mode, in share mode or under a lock.
import { allKinds } from '../../kinds';
import { addNode, deleteNodes, duplicate, markReviewed } from '../actions';
import { useBoard, useReadOnly, useStoreSelect, useUi } from '../context';

export type SidePanel = 'outline' | 'filters' | 'health' | 'comments' | 'fields' | 'share' | null;

interface Props {
  side: SidePanel;
  setSide: (s: SidePanel) => void;
  canManage: boolean;
  canComment: boolean;
  onPresent: () => void;
  onExport: () => void;
  centre: () => { x: number; y: number };
}

export default function Toolbar({ side, setSide, canManage, canComment, onPresent, onExport, centre }: Props) {
  const { store, ui, announce, mode, me } = useBoard();
  const readOnly = useReadOnly() || mode === 'share';
  const canUndo = useStoreSelect((s) => s.canUndo);
  const canRedo = useStoreSelect((s) => s.canRedo);
  const selection = useUi((s) => s.selection);
  const toggle = (p: SidePanel) => setSide(side === p ? null : p);
  const tab = (p: Exclude<SidePanel, null>, label: string) => (
    <button type="button" aria-pressed={side === p} onClick={() => toggle(p)}>{label}</button>
  );
  return (
    <div className="jb-toolbar" role="toolbar" aria-label="Board tools">
      {!readOnly && (
        <div className="jb-group" aria-label="Add">
          {allKinds().map((k) => (
            <button key={k.id} type="button" data-edit onClick={() => {
              const c = centre();
              const id = addNode(store, k.id, c.x, c.y);
              if (id) { announce(`${k.label} added`); if (k.capabilities.details || k.id === 'text' || k.id === 'stats') ui.set({ panelNodeId: id }); }
            }}>Add {k.label.toLowerCase()}</button>
          ))}
        </div>
      )}
      {!readOnly && (
        <div className="jb-group" aria-label="Edit">
          <button type="button" data-edit onClick={() => store.undo()} disabled={!canUndo}>Undo</button>
          <button type="button" data-edit onClick={() => store.redo()} disabled={!canRedo}>Redo</button>
          {selection.length > 0 && <>
            <button type="button" data-edit onClick={() => announce(`${duplicate(store, [...selection]).length} cards duplicated`)}>Duplicate</button>
            <button type="button" data-edit onClick={() => { markReviewed(store, [...selection], me?.name ?? 'Someone'); announce('Marked reviewed'); }}>Mark reviewed</button>
            <button type="button" data-edit className="jb-danger" onClick={() => { const n = deleteNodes(store, [...selection]); announce(`${n} cards deleted`); ui.set({ selection: [] }); }}>Delete ({selection.length})</button>
          </>}
        </div>
      )}
      <div className="jb-group" aria-label="View">
        {tab('outline', 'Outline')}
        {tab('filters', 'Filters')}
        {tab('health', 'Health')}
        {mode === 'collab' && tab('comments', canComment ? 'Comments' : 'Comments (read)')}
        {!readOnly && tab('fields', 'Fields')}
        {mode === 'collab' && canManage && tab('share', 'Share')}
        {mode === 'collab' && <button type="button" onClick={onExport}>Export</button>}
        <button type="button" onClick={onPresent}>Present</button>
      </div>
    </div>
  );
}
