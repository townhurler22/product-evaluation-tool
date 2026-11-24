'use client';
// One open board: loads metadata and content (PERF-24), wires the store, outbox, sync and live updates,
// and lays out tabs, toolbar, canvas, panels and banners (§8.1, §8.15, §8.16, §8.20).
import '@xyflow/react/dist/style.css';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardMeta } from '../../server/access';
import { BoardProvider, useBoard, useStoreSelect, useUi, type BoardCtx } from '../context';
import { BoardLive, stableColour, type Cursor, type PresenceUser } from '../live';
import { openOutbox, type OutboxPersistence } from '../persist';
import { BoardStore, type ContentIn, type RemoteBatch } from '../store';
import { BoardSync, type SyncStatus } from '../sync';
import { UiStore } from '../ui-store';
import Canvas, { type Pin } from './Canvas';
import Outline from './Outline';
import Panel, { EdgePanel } from './Panel';
import { FieldsPanel, FiltersPanel, HealthPanel, useDimming } from './Sidebars';
import { CommentsPanel, SharePanel, type Thread } from './Social';
import Toolbar, { type SidePanel } from './Toolbar';

const newId = () => crypto.randomUUID().replace(/-/g, '');

function statusText(s: SyncStatus): string | null {
  switch (s.kind) {
    case 'saved': return null;
    case 'saving': return 'Saving…';
    case 'offline': return `Offline. ${s.waiting} ${s.waiting === 1 ? 'change' : 'changes'} waiting.`;
    case 'retrying': return 'Couldn\'t sync. Changes are kept on this device.';
    case 'rights-lost': return `You can no longer edit this board. ${s.waiting} unsaved ${s.waiting === 1 ? 'change is' : 'changes are'} kept on this device.`;
    case 'locked': return 'This page needs to reload to keep editing.';
    case 'warning': return s.message;
  }
}

interface Loaded { me: { userId: string; name: string }; metas: BoardMeta[]; meta: BoardMeta; content: ContentIn & { viewport: { x: number; y: number; zoom: number } | null } }

export default function BoardApp({ boardId, deepNodeId }: { boardId: string; deepNodeId: string | null }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<'missing' | 'network' | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        // PERF-02: board metadata and content in parallel; journeys are never fetched here (D-20).
        const [meR, listR, contentR] = await Promise.all([fetch('/api/me'), fetch('/api/jb/boards'), fetch(`/api/jb/boards/${boardId}/content`)]);
        if (meR.status === 401) { window.location.href = '/'; return; }
        if (contentR.status === 404) { if (!off) setError('missing'); return; }
        if (!meR.ok || !listR.ok || !contentR.ok) throw new Error('load');
        const me = await meR.json(); const list = await listR.json(); const c = await contentR.json();
        if (!off) setLoaded({ me: { userId: me.userId, name: me.name ?? me.email ?? 'Team member' }, metas: list.boards, meta: c.meta, content: c.content });
      } catch { if (!off) setError('network'); }
    })();
    return () => { off = true; };
  }, [boardId, attempt]);

  if (error === 'missing') return <main className="jb-message"><h1>Board not found</h1><p>It may have been deleted, or you may not have access.</p><Link href="/jb">All boards</Link></main>;
  if (error === 'network') {
    // JB-2002: never edit from browser data alone.
    return <main className="jb-message"><h1>We could not load this board</h1><button type="button" onClick={() => { setError(null); setAttempt((a) => a + 1); }}>Try again</button></main>;
  }
  if (!loaded) return <main className="jb-message"><p role="status">Loading board…</p></main>;
  return <ReactFlowProvider><Board key={boardId} boardId={boardId} loaded={loaded} deepNodeId={deepNodeId} /></ReactFlowProvider>;
}

function Board({ boardId, loaded, deepNodeId }: { boardId: string; loaded: Loaded; deepNodeId: string | null }) {
  const [meta, setMeta] = useState(loaded.meta);
  const [metas, setMetas] = useState(loaded.metas);
  const store = useMemo(() => { const s = new BoardStore(newId(), !loaded.meta.rights.canEdit); s.load(loaded.content); return s; }, [loaded]);
  const ui = useMemo(() => new UiStore(), []);
  const rf = useReactFlow();
  const [status, setStatus] = useState<SyncStatus>({ kind: 'saved' });
  const [notice, setNotice] = useState<string | null>(() => (deepNodeId && !loaded.content.nodes.some((n) => n.id === deepNodeId) ? 'That card no longer exists' : null));
  const [memoryOnly, setMemoryOnly] = useState(false);
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [cursors, setCursors] = useState<Cursor[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [side, setSide] = useState<SidePanel>(null);
  const [present, setPresent] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [images, setImages] = useState<Record<string, string>>({});
  const requested = useRef(new Set<string>());
  const syncRef = useRef<BoardSync | null>(null);
  const liveRef = useRef<BoardLive | null>(null);

  const announce = useCallback((m: string) => { setAnnouncement(''); requestAnimationFrame(() => setAnnouncement(m)); }, []);
  const requestImages = useCallback((ids: string[]) => {
    const need = ids.filter((i) => !requested.current.has(i));
    if (!need.length) return;
    for (const i of need) requested.current.add(i);
    void fetch(`/api/jb/boards/${boardId}/images?ids=${need.map(encodeURIComponent).join(',')}`).then((r) => (r.ok ? r.json() : { urls: {} }))
      .then((b: { urls: Record<string, string> }) => setImages((cur) => ({ ...cur, ...b.urls })));
  }, [boardId]);

  const ctx: BoardCtx = useMemo(() => ({
    store, ui, boardId, mode: 'collab', me: loaded.me, announce, requestImages, imageUrl: (id: string) => images[id],
  }), [store, ui, boardId, loaded.me, announce, requestImages, images]);

  const refreshMeta = useCallback(async () => {
    const r = await fetch('/api/jb/boards');
    if (!r.ok) return;
    const list: BoardMeta[] = (await r.json()).boards;
    setMetas(list);
    const mine = list.find((m) => m.id === boardId);
    if (mine) {
      setMeta(mine);
      if (mine.rights.canEdit) syncRef.current?.rightsRestored(); else store.setReadOnly(true);
    }
  }, [boardId, store]);

  // Outbox, sync and live updates.
  useEffect(() => {
    const box: { persist: OutboxPersistence | null; closed: boolean } = { persist: null, closed: false };
    const sync = new BoardSync(store, {
      boardId, fetch: (u, i) => fetch(u, i), newId,
      loadContent: async () => (await (await fetch(`/api/jb/boards/${boardId}/content`)).json()).content,
      onStatus: setStatus, onNotice: (m) => { setNotice(m); announce(m); },
      persist: (s) => box.persist?.save(s),
    });
    syncRef.current = sync;
    store.setHandlers({ onRemoteDelete: (id) => { if (ui.state.panelNodeId === id) ui.set({ deletedNotice: 'This card was deleted by a collaborator.' }); } });
    void openOutbox(loaded.me.userId, boardId).then(async (p) => {
      if (box.closed) return;
      box.persist = p;
      setMemoryOnly(!p.available);
      const left = await p.load();
      // JB-1607: on boot with a leftover outbox, pull changes, rebase and send.
      if (left && (left.inflight || left.pending.length)) {
        store.restoreOutbox(left);
        await sync.pull();
        void sync.flush();
      }
    });
    const live = new BoardLive(boardId, { userId: loaded.me.userId, name: loaded.me.name, colour: stableColour(loaded.me.userId) }, {
      onOps: (b: RemoteBatch) => sync.onRemote(b),
      onPull: () => void sync.pull(),
      onComment: (payload, removed) => {
        if (removed) setThreads((all) => all.filter((t) => t.id !== payload.threadId));
        else if (payload.thread) setThreads((all) => [payload.thread as Thread, ...all.filter((t) => t.id !== (payload.thread as Thread).id)]);
        else if (payload.threadId) void fetch(`/api/jb/boards/${boardId}/comments?threadId=${payload.threadId}`).then((r) => r.json()).then((b) => setThreads((all) => [...b.threads, ...all.filter((t) => t.id !== payload.threadId)]));
      },
      onMeta: () => void refreshMeta(),
      onLocked: (reason) => { sync.lock(); setNotice(reason === 'deleted' ? 'This board was deleted.' : 'This page needs to reload to keep editing.'); },
      onPresence: (users) => setPresence(users.filter((u) => u.userId !== loaded.me.userId)),
      onCursor: (c) => setCursors((cs) => [...cs.filter((x) => x.userId !== c.userId), c]),
      onMode: (m) => ui.set({ live: m }),
    });
    liveRef.current = live;
    void live.start();
    const hide = () => sync.flushOnHide();
    window.addEventListener('pagehide', hide);
    const online = () => { void sync.pull().then(() => sync.flush()); };
    window.addEventListener('online', online);
    // JB-1505: cursors vanish after 15 s of silence.
    const sweep = setInterval(() => setCursors((cs) => cs.filter((c) => Date.now() - c.at < 15_000)), 5000);
    return () => {
      box.closed = true; sync.flushOnHide(); sync.dispose(); live.stop(); clearInterval(sweep);
      window.removeEventListener('pagehide', hide); window.removeEventListener('online', online);
    };
  }, [store, ui, boardId, loaded.me, announce, refreshMeta]);

  // Comments load after first paint (PERF-02).
  useEffect(() => {
    void fetch(`/api/jb/boards/${boardId}/comments`).then((r) => (r.ok ? r.json() : { threads: [] })).then((b) => setThreads(b.threads));
  }, [boardId]);
  useEffect(() => {
    const counts = new Map<string, number>();
    for (const t of threads) if (t.anchorNodeId && !t.resolvedAt) counts.set(t.anchorNodeId, (counts.get(t.anchorNodeId) ?? 0) + 1);
    ui.set({ commentCounts: counts });
  }, [threads, ui]);

  // JB-105 deep link: centre, highlight and open the card, or say it no longer exists.
  useEffect(() => {
    if (deepNodeId && store.view.nodes.has(deepNodeId)) ui.set({ highlighted: deepNodeId, panelNodeId: deepNodeId });
  }, [deepNodeId, store, ui]);

  const centre = useCallback(() => {
    const el = document.querySelector('.jb-canvas');
    const r = el?.getBoundingClientRect();
    return r ? rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 };
  }, [rf]);

  const exportBoard = async () => {
    const r = await fetch('/api/jb/boards/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ boardIds: [boardId] }) });
    if (!r.ok) { setNotice('Export failed'); return; }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a'); a.href = url; a.download = `${meta.name.replace(/[^\w -]/g, '')}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const pins: Pin[] = threads.flatMap((t) => {
    if (t.anchorType === 'BOARD') return [{ id: t.id, x: t.x, y: t.y, resolved: Boolean(t.resolvedAt), count: t.messages.length }];
    const n = t.anchorNodeId ? store.view.nodes.get(t.anchorNodeId) : undefined;
    return n ? [{ id: t.id, x: n.x + t.x + 200, y: n.y + t.y, resolved: Boolean(t.resolvedAt), count: t.messages.length }] : [];
  });

  const banner = statusText(status);
  const tabs = metas.filter((m) => !m.journeyOf);
  return (
    <BoardProvider value={ctx}>
      <Dimmer />
      <div className={`jb-app ${present ? 'jb-presenting' : ''}`}>
        {!present && (
          <header className="jb-header">
            <Link href="/" className="jb-back">Home</Link>
            <nav aria-label="Boards" className="jb-tabs">
              {tabs.map((m) => <Link key={m.id} href={`/jb/${m.id}`} aria-current={m.id === boardId ? 'page' : undefined} className="jb-tab">{m.name}</Link>)}
              <Link href="/jb" className="jb-tab">All boards</Link>
            </nav>
            <BoardName canEdit={meta.rights.canEdit} />
            <div className="jb-presence" aria-label="People on this board">
              {presence.map((p) => <span key={p.userId} className="jb-avatar" style={{ background: p.colour }} title={p.name}>{p.name.slice(0, 1).toUpperCase()}</span>)}
            </div>
            <LiveMode />
          </header>
        )}
        {!present && (
          <Toolbar side={side} setSide={setSide} canManage={meta.rights.canManage && !meta.journeyOf} canComment={meta.rights.canComment}
            onPresent={() => { setPresent(true); setSide(null); ui.set({ panelNodeId: null }); requestAnimationFrame(() => void rf.fitView()); }}
            onExport={() => void exportBoard()} centre={centre} />
        )}
        {!present && (banner || notice || memoryOnly) && (
          <div className="jb-banners">
            {banner && <p role="status" className="jb-banner">{banner}{status.kind === 'locked' && <button type="button" onClick={() => window.location.reload()}>Reload</button>}
              {status.kind === 'rights-lost' && <button type="button" onClick={() => { store.discardOutbox(); setStatus({ kind: 'saved' }); }}>Discard my changes</button>}</p>}
            {notice && <p role="status" className="jb-banner">{notice} <button type="button" onClick={() => setNotice(null)}>Dismiss</button></p>}
            {memoryOnly && <p className="jb-banner">Changes are not kept offline in this window.</p>}
          </div>
        )}
        {present && <button type="button" className="jb-exit-present" onClick={() => setPresent(false)}>Exit presentation</button>}
        <div className="jb-body">
          <Canvas pins={present ? [] : pins} cursors={present ? [] : cursors} onPin={() => setSide('comments')}
            onPointer={(x, y) => liveRef.current?.sendCursor(x, y)}
            onViewport={meta.rights.canEdit ? (v) => void fetch(`/api/jb/boards/${boardId}/viewport`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) }) : undefined}
            initialViewport={loaded.content.viewport} presentation={present} />
          {!present && side && (
            <div className="jb-sidebar">
              {side === 'outline' && <Outline />}
              {side === 'filters' && <FiltersPanel />}
              {side === 'health' && <HealthPanel />}
              {side === 'fields' && <FieldsPanel />}
              {side === 'comments' && <CommentsPanel threads={threads} setThreads={setThreads} canComment={meta.rights.canComment} canManage={meta.rights.canManage} pinAt={centre} />}
              {side === 'share' && <SharePanel workspaceCanEdit={meta.workspaceCanEdit} isJourney={Boolean(meta.journeyOf)} onChanged={() => void refreshMeta()} />}
            </div>
          )}
          {!present && <PanelHost threads={threads} setThreads={setThreads} canComment={meta.rights.canComment} canManage={meta.rights.canManage} />}
        </div>
        <div className="jb-sr" aria-live="polite" role="status">{announcement}</div>
      </div>
    </BoardProvider>
  );
}

/** Keeps dimming in step with filters and isolate mode; must render inside the provider. */
function Dimmer() { useDimming(); return null; }

function PanelHost({ threads, setThreads, canComment, canManage }: { threads: Thread[]; setThreads: (f: (t: Thread[]) => Thread[]) => void; canComment: boolean; canManage: boolean }) {
  const nodeId = useUi((s) => s.panelNodeId);
  const edgeId = useUi((s) => s.panelEdgeId);
  if (edgeId) return <EdgePanel id={edgeId} />;
  if (!nodeId) return null;
  return <Panel id={nodeId} comments={<CommentsPanel threads={threads} setThreads={setThreads} canComment={canComment} canManage={canManage} nodeId={nodeId} pinAt={() => ({ x: 0, y: 0 })} />} />;
}

function BoardName({ canEdit }: { canEdit: boolean }) {
  const name = useStoreSelect((s) => s.view.name);
  const readOnly = useStoreSelect((s) => s.readOnly);
  const { store } = useBoard();
  if (!canEdit || readOnly) return <h1 className="jb-title">{name}</h1>;
  return (
    <h1 className="jb-title">
      <label className="jb-sr" htmlFor="board-name">Board name</label>
      <input id="board-name" value={name} maxLength={200} onChange={(e) => { if (e.target.value.trim()) store.edit([{ type: 'board', op: 'patch', name: e.target.value }], { key: 'board:name' }); }} />
    </h1>
  );
}

function LiveMode() {
  const live = useUi((s) => s.live);
  // ARC-25 / JB-1506: degrade quietly; polling still converges.
  return <span className="jb-live" title={live === 'realtime' ? 'Live' : 'Updates every second'}>{live === 'realtime' ? 'Live' : live === 'offline' ? 'Live updates paused' : 'Syncing'}</span>;
}
