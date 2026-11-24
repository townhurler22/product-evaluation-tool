'use client';
// Comments (§8.12), collaborators, workspace edit and share links (§8.13, §8.14). None of these are ops.
import { useEffect, useState, type FormEvent } from 'react';
import type { CommentThread } from '../../server/comments';
import { useBoard } from '../context';

export type Thread = CommentThread;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? 'Something went wrong');
  return body as T;
}

function ThreadView({ t, canComment, canManage, onChange }: { t: Thread; canComment: boolean; canManage: boolean; onChange: (t: Thread | null) => void }) {
  const { boardId, me } = useBoard();
  const [reply, setReply] = useState(''); const [err, setErr] = useState('');
  const base = `/api/jb/boards/${boardId}/comments/${t.id}`;
  const run = async (p: Promise<{ thread?: Thread | null }>) => { try { setErr(''); const r = await p; onChange(r.thread ?? null); } catch (e) { setErr((e as Error).message); } };
  return (
    <li className={`jb-thread ${t.resolvedAt ? 'jb-thread-resolved' : ''}`}>
      <ul>{t.messages.map((m) => (
        <li key={m.id}><strong>{m.authorName ?? 'Someone'}</strong> <span className="jb-quiet">{new Date(m.createdAt).toLocaleString('en-GB')}{m.editedAt ? ' (edited)' : ''}</span>
          <p className="jb-pre">{m.body}</p></li>
      ))}</ul>
      {canComment && (
        <form className="jb-inline-form" onSubmit={(e: FormEvent) => { e.preventDefault(); if (reply.trim()) void run(api(base, { method: 'POST', body: JSON.stringify({ body: reply }) })).then(() => setReply('')); }}>
          <label className="jb-sr" htmlFor={`r-${t.id}`}>Reply</label>
          <textarea id={`r-${t.id}`} rows={2} maxLength={2000} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply" />
          <button type="submit">Reply</button>
          <button type="button" onClick={() => void run(api(base, { method: 'PATCH', body: JSON.stringify({ resolved: !t.resolvedAt }) }))}>{t.resolvedAt ? 'Reopen' : 'Resolve'}</button>
          {(t.authorId === me?.userId || canManage) && <button type="button" className="jb-danger" onClick={() => void run(api(base, { method: 'DELETE' }).then(() => ({ thread: null })))}>Delete thread</button>}
        </form>
      )}
      {err && <p role="alert" className="jb-error">{err}</p>}
    </li>
  );
}

export function CommentsPanel({ threads, setThreads, canComment, canManage, nodeId, pinAt }: {
  threads: Thread[]; setThreads: (f: (t: Thread[]) => Thread[]) => void; canComment: boolean; canManage: boolean;
  nodeId?: string | null; pinAt: () => { x: number; y: number };
}) {
  const { boardId, store } = useBoard();
  const [body, setBody] = useState(''); const [err, setErr] = useState('');
  const shown = threads.filter((t) => (nodeId ? t.anchorNodeId === nodeId : true))
    .sort((a, b) => Number(Boolean(a.resolvedAt)) - Number(Boolean(b.resolvedAt))); // JB-1203: open first
  const upsert = (t: Thread | null, id: string) => setThreads((all) => (t ? [t, ...all.filter((x) => x.id !== t.id)] : all.filter((x) => x.id !== id)));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    const p = pinAt();
    try {
      const r = await api<{ thread: Thread }>(`/api/jb/boards/${boardId}/comments`, { method: 'POST', body: JSON.stringify(
        nodeId ? { anchorType: 'NODE', anchorNodeId: nodeId, x: 20, y: -10, body } : { anchorType: 'BOARD', x: p.x, y: p.y, body }) });
      upsert(r.thread, r.thread.id); setBody(''); setErr('');
    } catch (ex) { setErr((ex as Error).message); }
  };
  return (
    <section className="jb-side" aria-label={nodeId ? 'Comments on this card' : 'Comments'}>
      <h2>{nodeId ? 'Comments on this card' : 'Comments'}</h2>
      {canComment && (
        <form onSubmit={submit} className="jb-inline-form">
          <label className="jb-sr" htmlFor={`new-comment-${nodeId ?? 'board'}`}>New comment</label>
          <textarea id={`new-comment-${nodeId ?? 'board'}`} rows={3} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} placeholder={nodeId ? 'Comment on this card' : 'Comment pinned to the middle of the view'} />
          <button type="submit">Post comment</button>
          {err && <p role="alert" className="jb-error">{err}</p>}
        </form>
      )}
      <ul className="jb-threads">
        {shown.map((t) => (
          <div key={t.id}>
            {t.anchorNodeId && !store.view.nodes.has(t.anchorNodeId) && <p className="jb-quiet">On a deleted card</p>}
            <ThreadView t={t} canComment={canComment} canManage={canManage} onChange={(nt) => upsert(nt, t.id)} />
          </div>
        ))}
        {!shown.length && <li className="jb-quiet">No comments yet</li>}
      </ul>
    </section>
  );
}

interface Collab { userId: string; email: string; name: string | null; role: 'EDITOR' | 'COMMENTER' | 'VIEWER' }
interface Link { id: string; createdAt: string; revokedAt: string | null; hasPassword: boolean; expiresAt: string | null }

export function SharePanel({ workspaceCanEdit, isJourney, onChanged }: { workspaceCanEdit: boolean; isJourney: boolean; onChanged: () => void }) {
  const { boardId } = useBoard();
  const [collabs, setCollabs] = useState<Collab[]>([]); const [links, setLinks] = useState<Link[]>([]);
  const [email, setEmail] = useState(''); const [role, setRole] = useState<Collab['role']>('EDITOR');
  const [msg, setMsg] = useState(''); const [newUrl, setNewUrl] = useState(''); const [password, setPassword] = useState('');
  const load = async () => {
    const c = await api<{ collaborators: Collab[] }>(`/api/jb/boards/${boardId}/collaborators`).catch(() => ({ collaborators: [] }));
    setCollabs(c.collaborators);
    const l = await api<{ links: Link[] }>(`/api/core/share-links?module=jb&targetKind=board&targetId=${boardId}`).catch(() => ({ links: [] }));
    setLinks(l.links);
  };
  // Fetch on mount; state is set after the response arrives.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [boardId]);
  const act = async (p: Promise<unknown>, ok: string) => { try { await p; setMsg(ok); await load(); onChanged(); } catch (e) { setMsg((e as Error).message); } };
  return (
    <section className="jb-side" aria-label="Sharing">
      <h2>Sharing</h2>
      {msg && <p role="status">{msg}</p>}
      {!isJourney && (
        <label className="jb-check"><input type="checkbox" checked={workspaceCanEdit}
          onChange={(e) => void act(api(`/api/jb/boards/${boardId}/access`, { method: 'PATCH', body: JSON.stringify({ workspaceCanEdit: e.target.checked }) }), 'Saved')} /> Everyone in the workspace can edit</label>
      )}
      <h3>People</h3>
      <form className="jb-inline-form" onSubmit={(e) => { e.preventDefault(); void act(api(`/api/jb/boards/${boardId}/collaborators`, { method: 'POST', body: JSON.stringify({ email, role }) }), 'Invited').then(() => setEmail('')); }}>
        <label className="jb-sr" htmlFor="invite-email">Email</label>
        <input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
        <label className="jb-sr" htmlFor="invite-role">Role</label>
        <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Collab['role'])}><option value="EDITOR">Editor</option><option value="COMMENTER">Commenter</option><option value="VIEWER">Viewer</option></select>
        <button type="submit">Invite</button>
      </form>
      <ul>{collabs.map((c) => (
        <li key={c.userId}>{c.name ?? c.email} <span className="jb-quiet">{c.email}</span>
          <select aria-label={`Role for ${c.email}`} value={c.role} onChange={(e) => void act(api(`/api/jb/boards/${boardId}/collaborators`, { method: 'PATCH', body: JSON.stringify({ userId: c.userId, role: e.target.value }) }), 'Role changed')}>
            <option value="EDITOR">Editor</option><option value="COMMENTER">Commenter</option><option value="VIEWER">Viewer</option></select>
          <button type="button" onClick={() => void act(api(`/api/jb/boards/${boardId}/collaborators?userId=${c.userId}`, { method: 'DELETE' }), 'Removed')}>Remove</button>
        </li>
      ))}</ul>
      {!isJourney && <>
        <h3>View-only link</h3>
        <p className="jb-quiet">Anyone with the link can view this board and its detailed journeys. The link is shown once.</p>
        <form className="jb-inline-form" onSubmit={(e) => { e.preventDefault(); void (async () => {
          try {
            const r = await api<{ url: string }>('/api/core/share-links', { method: 'POST', body: JSON.stringify({ module: 'jb', targetKind: 'board', targetId: boardId, capabilities: ['VIEW'], password: password || null }) });
            setNewUrl(r.url); setPassword(''); await load();
          } catch (ex) { setMsg((ex as Error).message); }
        })(); }}>
          <label className="jb-sr" htmlFor="link-pw">Optional password</label>
          <input id="link-pw" type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Optional password (8+ characters)" />
          <button type="submit">Create link</button>
        </form>
        {newUrl && <p><label className="jb-row-label" htmlFor="new-link">Copy this link now</label><input id="new-link" readOnly value={newUrl} onFocus={(e) => e.target.select()} /></p>}
        <ul>{links.map((l) => (
          <li key={l.id}>Created {new Date(l.createdAt).toLocaleDateString('en-GB')}{l.hasPassword ? ', password' : ''}{l.revokedAt ? ', revoked' : ''}
            {!l.revokedAt && <button type="button" onClick={() => void act(api(`/api/core/share-links/${l.id}/revoke`, { method: 'POST' }), 'Link revoked')}>Revoke</button>}</li>
        ))}</ul>
      </>}
    </section>
  );
}
