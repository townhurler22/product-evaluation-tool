'use client';
// Board share view (JB-1403, JB-1404, OD-24 (a)): the board and its detailed journeys, read-only.
// Persists nothing in the browser and has no save loop, presence or comments. "Refresh" reloads content.
import '@xyflow/react/dist/style.css';
import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { BoardProvider, useUi, type BoardCtx } from '../context';
import { BoardStore, type ContentIn } from '../store';
import { UiStore } from '../ui-store';
import Canvas from './Canvas';
import Outline from './Outline';
import Panel from './Panel';
import { useDimming } from './Sidebars';

interface PublicMeta { id: string; name: string; journeyOfNodeId: string | null }

export default function ShareView({ token }: { token: string }) {
  const [password, setPassword] = useState<string | null>(null);
  const [needPw, setNeedPw] = useState<'none' | 'ask' | 'wrong'>('none');
  const [missing, setMissing] = useState(false);
  const [board, setBoard] = useState<PublicMeta | null>(null);
  const [journeys, setJourneys] = useState<PublicMeta[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [content, setContent] = useState<ContentIn | null>(null);
  const [version, setVersion] = useState(0);
  const headers = useMemo((): Record<string, string> => (password ? { 'x-share-password': password } : {}), [password]);

  const load = useCallback(async () => {
    const r = await fetch(`/api/share/${token}/jb/board`, { headers, cache: 'no-store' });
    if (r.status === 401) { setNeedPw('ask'); return; }
    if (r.status === 403) { setNeedPw('wrong'); return; }
    if (!r.ok) { setMissing(true); return; }
    const b = await r.json();
    setNeedPw('none'); setBoard(b.board); setJourneys(b.journeys);
    setCurrent((c) => c ?? b.board.id);
    if (!current || current === b.board.id) { setContent({ ...b.content, name: b.board.name }); setVersion((v) => v + 1); }
  }, [token, headers, current]);

  // Fetch on mount; state is set after the response arrives.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const open = async (id: string, name: string) => {
    const r = await fetch(`/api/share/${token}/jb/boards/${id}/content`, { headers, cache: 'no-store' });
    if (!r.ok) return;
    setCurrent(id); setContent({ ...(await r.json()), name }); setVersion((v) => v + 1);
  };

  if (missing) return <main className="jb-message"><h1>This link is not available</h1><p>It may have expired or been revoked.</p></main>;
  if (needPw !== 'none') {
    return (
      <main className="jb-message">
        <h1>This board needs a password</h1>
        <form onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); setPassword(String(new FormData(e.currentTarget).get('pw') ?? '')); }}>
          <label htmlFor="pw">Password</label> <input id="pw" name="pw" type="password" required aria-describedby={needPw === 'wrong' ? 'pw-err' : undefined} />
          <button type="submit">View board</button>
          {needPw === 'wrong' && <p id="pw-err" role="alert">That password is not right.</p>}
        </form>
      </main>
    );
  }
  if (!board || !content || !current) return <main className="jb-message"><p role="status">Loading board…</p></main>;
  return (
    <ReactFlowProvider>
      <ShareBoard key={`${current}:${version}`} token={token} boardId={current} content={content} headers={headers}
        tabs={[board, ...journeys]} onOpen={(m) => (m.id === board.id ? void load().then(() => setCurrent(board.id)) : void open(m.id, m.name))}
        onRefresh={() => (current === board.id ? void load() : void open(current, content.name))} />
    </ReactFlowProvider>
  );
}

function ShareBoard({ token, boardId, content, headers, tabs, onOpen, onRefresh }: {
  token: string; boardId: string; content: ContentIn; headers: Record<string, string>; tabs: PublicMeta[];
  onOpen: (m: PublicMeta) => void; onRefresh: () => void;
}) {
  const store = useMemo(() => { const s = new BoardStore('share', true); s.load(content); return s; }, [content]);
  const ui = useMemo(() => new UiStore(), []);
  const [images, setImages] = useState<Record<string, string>>({});
  const [outline, setOutline] = useState(false);
  const requestImages = useCallback((ids: string[]) => {
    void fetch(`/api/share/${token}/jb/boards/${boardId}/images?ids=${ids.map(encodeURIComponent).join(',')}`, { headers, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { urls: {} })).then((b: { urls: Record<string, string> }) => setImages((c) => ({ ...c, ...b.urls })));
  }, [token, boardId, headers]);
  const ctx: BoardCtx = useMemo(() => ({
    store, ui, boardId, mode: 'share', me: null, announce: () => {}, requestImages, imageUrl: (id: string) => images[id],
  }), [store, ui, boardId, requestImages, images]);
  return (
    <BoardProvider value={ctx}>
      <ShareInner tabs={tabs} current={boardId} onOpen={onOpen} onRefresh={onRefresh} outline={outline} setOutline={setOutline} />
    </BoardProvider>
  );
}

function ShareInner({ tabs, current, onOpen, onRefresh, outline, setOutline }: {
  tabs: PublicMeta[]; current: string; onOpen: (m: PublicMeta) => void; onRefresh: () => void; outline: boolean; setOutline: (b: boolean) => void;
}) {
  useDimming();
  const panel = useUi((s) => s.panelNodeId);
  return (
    <div className="jb-app">
      <header className="jb-header">
        <nav aria-label="Board and journeys" className="jb-tabs">
          {tabs.map((t) => (
            <button key={t.id} type="button" className="jb-tab" aria-current={t.id === current ? 'page' : undefined} onClick={() => onOpen(t)}>
              {t.journeyOfNodeId ? `Journey: ${t.name}` : t.name}
            </button>
          ))}
        </nav>
        <span className="jb-live">View only</span>
        <button type="button" onClick={() => setOutline(!outline)} aria-pressed={outline}>Outline</button>
        <button type="button" onClick={onRefresh}>Refresh</button>
      </header>
      <div className="jb-body">
        <Canvas pins={[]} cursors={[]} onPin={() => {}} initialViewport={null} />
        {outline && <div className="jb-sidebar"><Outline /></div>}
        {panel && <Panel id={panel} />}
      </div>
    </div>
  );
}
