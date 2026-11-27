'use client';

// Forum administration (§7.17): forums, share links, status visibility and each forum's posts with voters.
// Feedback admins only (FH-007); permanent delete needs the post-delete grant (OD-03).
import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { statusKeyOf, statusLabel, type StatusKey } from '@/modules/fh/domain';
import type { AdminPost, ForumAdminRow, StatusConfigRow } from '@/modules/fh/forum-admin';
import { api, ApiFailure } from '../_lib/api';
import { useLookups } from '../_lib/data';
import { btn, btnPrimary, input, Markdown, shortDate, StatusPill } from './ui';

const fkeys = {
  forums: ['fh', 'forums'] as const,
  status: ['fh', 'status-config'] as const,
  posts: (id: string, offset: number) => ['fh', 'forums', id, 'posts', offset] as const,
};

function Section({ title, children, id }: { title: string; children: ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="rounded-lg border border-[var(--border)] p-4">
      <h2 id={id} className="text-lg font-semibold">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function ForumsAdmin() {
  const lookups = useLookups();
  const isAdmin = lookups.data?.access.feedbackAdmin ?? false;
  const canDelete = lookups.data?.access.canDeletePosts ?? false;
  const forums = useQuery({ queryKey: fkeys.forums, enabled: isAdmin, queryFn: () => api<{ forums: ForumAdminRow[] }>('/api/fh/forums').then((r) => r.forums) });
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  if (lookups.data && !isAdmin) {
    return <main className="px-4 py-6"><h1 className="text-2xl font-bold">Forums</h1><p className="mt-4">Forum administration is for feedback admins.</p></main>;
  }
  const current = forums.data?.find((f) => f.id === selected) ?? null;
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <h1 className="text-2xl font-bold">Forums</h1>
      <p role="status" aria-live="polite" className="text-sm">{message}</p>
      <CreateForum onCreated={(f) => { setSelected(f.id); setMessage(`Created ${f.name}.`); }} />
      <Section title="Your forums" id="forums-h">
        {forums.isLoading && <p className="text-sm text-[var(--muted)]">Loading…</p>}
        {forums.error && <p role="alert" className="text-sm text-[var(--danger)]">{(forums.error as Error).message}</p>}
        {forums.data?.length === 0 && <p className="text-sm text-[var(--muted)]">No forums yet.</p>}
        <ul className="space-y-3">
          {forums.data?.map((f) => <ForumCard key={f.id} forum={f} open={selected === f.id} onOpen={() => setSelected(selected === f.id ? null : f.id)} onMessage={setMessage} />)}
        </ul>
      </Section>
      {current && <PostsAdmin forum={current} canDelete={canDelete} onMessage={setMessage} />}
      <StatusVisibility onMessage={setMessage} />
    </main>
  );
}

function CreateForum({ onCreated }: { onCreated: (f: ForumAdminRow) => void }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    try {
      const r = await api<{ forum: ForumAdminRow }>('/api/fh/forums', { method: 'POST', body: { name: String(fd.get('name') ?? ''), prompt: String(fd.get('prompt') ?? '') || null } });
      form.reset(); setErr(null);
      await qc.invalidateQueries({ queryKey: fkeys.forums });
      onCreated(r.forum);
    } catch (x) { setErr((x as Error).message); }
  };
  return (
    <Section title="Create a forum" id="create-h">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
        <label className="block text-sm font-medium">Name<input name="name" required maxLength={120} className={`${input} mt-1 w-full`} aria-describedby={err ? 'create-err' : undefined} /></label>
        <label className="block text-sm font-medium">Submission prompt (optional)<input name="prompt" maxLength={500} className={`${input} mt-1 w-full`} placeholder="What would make your work easier?" /></label>
        <button type="submit" className={btnPrimary}>Create</button>
      </form>
      {err && <p id="create-err" role="alert" className="mt-2 text-sm text-[var(--danger)]">{err}</p>}
    </Section>
  );
}

function ForumCard({ forum, open, onOpen, onMessage }: { forum: ForumAdminRow; open: boolean; onOpen: () => void; onMessage: (m: string) => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const patch = async (body: Record<string, unknown>, done: string) => {
    try {
      await api(`/api/fh/forums/${forum.id}`, { method: 'PATCH', body });
      setErr(null); setEditing(false); onMessage(done);
      await qc.invalidateQueries({ queryKey: fkeys.forums });
    } catch (x) { setErr((x as Error).message); }
  };
  return (
    <li className={`rounded-md border border-[var(--border)] p-3 ${forum.isArchived ? 'opacity-80' : ''}`}>
      {editing ? (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); patch({ name: String(fd.get('name')), prompt: String(fd.get('prompt') ?? '') || null }, `Saved ${fd.get('name')}.`); }}>
          <label className="block text-sm font-medium">Name<input name="name" defaultValue={forum.name} required maxLength={120} className={`${input} mt-1 w-full`} /></label>
          <label className="block text-sm font-medium">Submission prompt<textarea name="prompt" defaultValue={forum.prompt ?? ''} maxLength={500} rows={2} className={`${input} mt-1 w-full`} /></label>
          <div className="flex gap-2"><button type="submit" className={btnPrimary}>Save</button><button type="button" className={btn} onClick={() => setEditing(false)}>Cancel</button></div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="font-semibold">{forum.name}</h3>
            <span className="text-xs text-[var(--muted)]">/{forum.slug}</span>
            {forum.isMain && <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-900">Main forum</span>}
            {forum.isArchived && <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-semibold text-gray-800">Archived</span>}
            <span className="text-xs text-[var(--muted)]">{forum.postCount} {forum.postCount === 1 ? 'post' : 'posts'}</span>
          </div>
          {forum.prompt && <p className="mt-1 text-sm text-[var(--muted)]">{forum.prompt}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <button className={btn} aria-expanded={open} onClick={onOpen}>{open ? 'Hide posts' : 'Posts'}</button>
            <button className={btn} aria-expanded={showLinks} onClick={() => setShowLinks((x) => !x)}>Share links ({forum.links.filter((l) => !l.revokedAt).length})</button>
            <button className={btn} onClick={() => setEditing(true)}>Edit</button>
            {!forum.isMain && <button className={btn} disabled={forum.isArchived} title={forum.isArchived ? 'An archived forum cannot be the main forum' : undefined}
              onClick={() => patch({ main: true }, `${forum.name} is now the main forum.`)}>Make main forum</button>}
            <button className={btn} onClick={() => patch({ archived: !forum.isArchived }, forum.isArchived ? `${forum.name} is back.` : `${forum.name} is archived. Its links stop working until you un-archive it.`)}>
              {forum.isArchived ? 'Un-archive' : 'Archive'}
            </button>
          </div>
        </>
      )}
      {err && <p role="alert" className="mt-2 text-sm text-[var(--danger)]">{err}</p>}
      {showLinks && <ShareLinks forum={forum} onMessage={onMessage} />}
    </li>
  );
}

type Link = ForumAdminRow['links'][number];

function linkState(l: Link): string {
  if (l.revokedAt) return 'Revoked';
  if (l.expiresAt && new Date(l.expiresAt) <= new Date()) return 'Expired';
  if (l.maxUses !== null && l.useCount >= l.maxUses) return 'Used up';
  return 'Active';
}

function ShareLinks({ forum, onMessage }: { forum: ForumAdminRow; onMessage: (m: string) => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: fkeys.forums });
  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const capabilities = ['VIEW', ...(['SUBMIT', 'VOTE'] as const).filter((c) => fd.get(c) === 'on')];
    const expiry = String(fd.get('expiresAt') ?? '');
    try {
      const r = await api<{ url: string }>('/api/core/share-links', {
        method: 'POST', body: {
          module: 'fh', targetKind: 'forum', targetId: forum.id, capabilities,
          password: String(fd.get('password') ?? '') || null,
          maxUses: fd.get('maxUses') ? Number(fd.get('maxUses')) : null,
          expiresAt: expiry ? new Date(`${expiry}T23:59:59`).toISOString() : null,
        },
      });
      setUrl(r.url); setErr(null);
      form.reset();
      await refresh();
    } catch (x) { setErr((x as Error).message); }
  };
  const act = async (path: string, body: unknown, done: string) => {
    try { await api(path, { method: path.endsWith('revoke') ? 'POST' : 'PATCH', body }); onMessage(done); await refresh(); }
    catch (x) { setErr((x as ApiFailure).message); }
  };
  return (
    <div className="mt-3 space-y-3 border-t border-[var(--border)] pt-3">
      {url && (
        // OD-04: only the hash is stored, so the address is shown once.
        <div role="status" className="rounded-md border border-[var(--accent)] p-2 text-sm">
          <p className="font-medium">Copy this link now. It is shown once.</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <input readOnly value={url} aria-label="New share link" className={`${input} min-w-0 flex-1`} onFocus={(e) => e.currentTarget.select()} />
            <button className={btn} onClick={async () => { try { await navigator.clipboard.writeText(url); onMessage('Link copied.'); } catch { onMessage('Select the link and copy it.'); } }}>Copy</button>
            <button className={btn} onClick={() => setUrl(null)}>Done</button>
          </div>
        </div>
      )}
      {forum.links.length > 0 && (
        <ul className="space-y-2 text-sm">
          {forum.links.map((l) => {
            const state = linkState(l);
            return (
              <li key={l.id} className="flex flex-wrap items-center gap-2 rounded border border-[var(--border)] p-2">
                <span className="font-medium">{state}</span>
                <span>{l.capabilities.map((c) => ({ VIEW: 'View', SUBMIT: 'Submit', VOTE: 'Vote' }[c] ?? c)).join(', ')}</span>
                <span className="text-[var(--muted)]">{l.hasPassword ? 'Password' : 'No password'}</span>
                <span className="text-[var(--muted)]">{l.useCount} {l.maxUses !== null ? `of ${l.maxUses} uses` : 'uses'}</span>
                {l.expiresAt && <span className="text-[var(--muted)]">Expires {shortDate(l.expiresAt)}</span>}
                <span className="text-[var(--muted)]">Created {shortDate(l.createdAt)}</span>
                {!l.revokedAt && (
                  <span className="ml-auto flex flex-wrap gap-1">
                    <button className={btn} onClick={() => { const pw = window.prompt('New password (at least 8 characters)'); if (pw) act(`/api/core/share-links/${l.id}`, { password: pw }, 'Password changed.'); }}>Change password</button>
                    {l.hasPassword && <button className={btn} onClick={() => act(`/api/core/share-links/${l.id}`, { password: null }, 'Password removed.')}>Clear password</button>}
                    <button className={`${btn} text-[var(--danger)]`} onClick={() => act(`/api/core/share-links/${l.id}/revoke`, undefined, 'Link revoked.')}>Revoke</button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {forum.isArchived ? <p className="text-sm text-[var(--muted)]">Un-archive this forum to create links.</p> : (
        <form onSubmit={create} className="space-y-2 text-sm" aria-label={`New share link for ${forum.name}`}>
          <fieldset className="flex flex-wrap gap-4"><legend className="font-medium">Visitors can</legend>
            <label><input type="checkbox" checked disabled /> View</label>
            <label><input type="checkbox" name="SUBMIT" defaultChecked /> Submit ideas</label>
            <label><input type="checkbox" name="VOTE" defaultChecked /> Vote</label>
          </fieldset>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="block">Password (optional)<input name="password" type="password" minLength={8} maxLength={200} autoComplete="new-password" className={`${input} mt-1 w-full`} /></label>
            <label className="block">Maximum uses (optional)<input name="maxUses" type="number" min={1} className={`${input} mt-1 w-full`} /></label>
            <label className="block">Expires (optional)<input name="expiresAt" type="date" className={`${input} mt-1 w-full`} /></label>
          </div>
          <button type="submit" className={btnPrimary}>Create link</button>
        </form>
      )}
      {err && <p role="alert" className="text-sm text-[var(--danger)]">{err}</p>}
    </div>
  );
}

// ── status visibility (FH-1105) ──────────────────────────────────────────────────────────────────────────────
function StatusVisibility({ onMessage }: { onMessage: (m: string) => void }) {
  const q = useQuery({ queryKey: fkeys.status, queryFn: () => api<{ items: StatusConfigRow[] }>('/api/fh/status-config').then((r) => r.items) });
  const [draft, setDraft] = useState<StatusConfigRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const rows = draft ?? q.data ?? [];
  const set = (k: string, patch: Partial<StatusConfigRow>) => setDraft(rows.map((r) => (r.statusKey === k ? { ...r, ...patch } : r)));
  const save = async () => {
    try {
      const r = await api<{ items: StatusConfigRow[] }>('/api/fh/status-config', { method: 'PUT', body: { items: rows.map((r) => ({ ...r, label: r.label || null })) } });
      setDraft(r.items); setDraft(null); setErr(null); onMessage('Status visibility saved.');
      q.refetch();
    } catch (x) { setErr((x as Error).message); }
  };
  return (
    <Section title="Status visibility" id="status-h">
      <p className="text-sm text-[var(--muted)]">Choose which statuses the public forum shows, and as what. Anything not public shows as &quot;Under consideration&quot;. &quot;Complete&quot; statuses fill the Complete tab.</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm">
          <thead><tr className="text-left"><th scope="col" className="py-1">Status</th><th scope="col">Public</th><th scope="col">Shown as</th><th scope="col">Kind</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.statusKey} className="border-t border-[var(--border)]">
                <th scope="row" className="py-1 pr-2 text-left font-normal">{statusLabel(r.statusKey as StatusKey, true)}</th>
                <td><input type="checkbox" checked={r.isPublic} aria-label={`${statusLabel(r.statusKey as StatusKey, true)} is public`} onChange={(e) => set(r.statusKey, { isPublic: e.target.checked })} className="h-5 w-5" /></td>
                <td className="pr-2"><input value={r.label ?? ''} maxLength={60} placeholder="Under consideration" aria-label={`${statusLabel(r.statusKey as StatusKey, true)} shown as`}
                  onChange={(e) => set(r.statusKey, { label: e.target.value })} className={`${input} w-full`} /></td>
                <td><select value={r.kind ?? ''} aria-label={`${statusLabel(r.statusKey as StatusKey, true)} kind`} onChange={(e) => set(r.statusKey, { kind: (e.target.value || null) as StatusConfigRow['kind'] })} className={input}>
                  <option value="">None</option><option value="complete">Complete</option><option value="closed">Closed</option>
                </select></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {err && <p role="alert" className="mt-2 text-sm text-[var(--danger)]">{err}</p>}
      <div className="mt-3 flex gap-2">
        <button className={btnPrimary} disabled={!draft} onClick={save}>Save</button>
        {draft && <button className={btn} onClick={() => setDraft(null)}>Discard changes</button>}
      </div>
    </Section>
  );
}

// ── posts (FH-1106 to FH-1108, FH-1254) ──────────────────────────────────────────────────────────────────────
function PostsAdmin({ forum, canDelete, onMessage }: { forum: ForumAdminRow; canDelete: boolean; onMessage: (m: string) => void }) {
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: fkeys.posts(forum.id, offset),
    queryFn: () => api<{ posts: AdminPost[]; total: number; nextOffset: number | null }>(`/api/fh/forums/${forum.id}/posts?offset=${offset}`),
  });
  return (
    <Section title={`Posts in ${forum.name}`} id="posts-h">
      {q.isLoading && <p className="text-sm text-[var(--muted)]">Loading…</p>}
      {q.data && q.data.total === 0 && <p className="text-sm text-[var(--muted)]">No posts yet.</p>}
      <ul className="space-y-3">
        {q.data?.posts.map((p) => <AdminPostRow key={p.id} forumId={forum.id} post={p} canDelete={canDelete} onChanged={(m) => { onMessage(m); q.refetch(); }} />)}
      </ul>
      {q.data && q.data.total > 50 && (
        <nav aria-label="Posts pages" className="mt-3 flex items-center gap-2 text-sm">
          <button className={btn} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button>
          <span>{offset + 1} to {Math.min(offset + 50, q.data.total)} of {q.data.total}</span>
          <button className={btn} disabled={q.data.nextOffset === null} onClick={() => setOffset(q.data!.nextOffset ?? offset)}>Next</button>
        </nav>
      )}
    </Section>
  );
}

function AdminPostRow({ forumId, post, canDelete, onChanged }: { forumId: string; post: AdminPost; canDelete: boolean; onChanged: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const base = `/api/fh/forums/${forumId}/posts/${post.id}`;
  const run = async (fn: () => Promise<string>) => { try { onChanged(await fn()); setErr(null); } catch (x) { setErr((x as Error).message); } };
  return (
    <li className="rounded-md border border-[var(--border)] p-3">
      {editing ? (
        <form className="space-y-2" onSubmit={(e) => {
          e.preventDefault(); const fd = new FormData(e.currentTarget);
          run(async () => { await api(base, { method: 'PATCH', body: { title: String(fd.get('title')), details: String(fd.get('details') ?? '') || null } }); setEditing(false); return 'Post saved. The linked idea is unchanged.'; });
        }}>
          <label className="block text-sm font-medium">Title<input name="title" defaultValue={post.title} required maxLength={200} className={`${input} mt-1 w-full`} /></label>
          <label className="block text-sm font-medium">Details<textarea name="details" defaultValue={post.details ?? ''} maxLength={5000} rows={4} className={`${input} mt-1 w-full`} /></label>
          <div className="flex gap-2"><button type="submit" className={btnPrimary}>Save</button><button type="button" className={btn} onClick={() => setEditing(false)}>Cancel</button></div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-semibold">{post.title}</h3>
            <span className="text-sm tabular-nums">{post.voteCount} {post.voteCount === 1 ? 'vote' : 'votes'}</span>
          </div>
          {post.details && <div className="mt-1"><Markdown text={post.details} /></div>}
          <p className="mt-1 text-xs text-[var(--muted)]">
            {shortDate(post.createdAt)} · {post.publishedBy ? `Published by ${post.publishedBy}` : `By ${post.author ?? 'Anonymous'}`}
            {post.imageCount > 0 && ` · ${post.imageCount} ${post.imageCount === 1 ? 'screenshot' : 'screenshots'}`}
          </p>
          {post.ideas.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2 text-sm">
              {post.ideas.map((i) => (
                <li key={i.id} className="flex items-center gap-1">
                  <a href={`/fh/ideas?idea=${i.id}`} className="text-[var(--accent)] underline">#{i.number} {i.title}</a>
                  <StatusPill status={statusKeyOf(i)} />
                </li>
              ))}
            </ul>
          )}
          <details className="mt-2 text-sm">
            <summary className="min-h-6 cursor-pointer">Voters ({post.voters.length}{post.voteCount > post.voters.length ? ` of ${post.voteCount}` : ''})</summary>
            <ul className="mt-1 list-disc pl-5">{post.voters.map((v, n) => <li key={n}>{v}</li>)}</ul>
          </details>
          <div className="mt-2 flex flex-wrap gap-2">
            <button className={btn} aria-pressed={post.teamVoted} onClick={() => run(async () => {
              await api(`${base}/team-vote`, { method: post.teamVoted ? 'DELETE' : 'POST' });
              return post.teamVoted ? 'Team vote removed.' : 'Voted as a team member.';
            })}>{post.teamVoted ? 'Team vote cast' : 'Vote as team member'}</button>
            <button className={btn} onClick={() => setEditing(true)}>Edit</button>
            {canDelete && !confirming && <button className={`${btn} text-[var(--danger)]`} onClick={() => setConfirming(true)}>Delete…</button>}
          </div>
          {confirming && (
            // FH-1108: a two-step inline confirm, not a browser dialog.
            <div role="group" aria-label="Confirm delete" className="mt-2 rounded-md border border-[var(--danger)] p-2 text-sm">
              <p>Delete this post permanently? Its votes and screenshots go too. A linked idea is deleted only if nobody has worked on it; otherwise it is kept. This cannot be undone.</p>
              <div className="mt-2 flex gap-2">
                <button className={`${btn} border-[var(--danger)] text-[var(--danger)]`} onClick={() => run(async () => {
                  const r = await api<{ deletedIdeaIds: string[]; keptIdeaIds: string[] }>(base, { method: 'DELETE' });
                  setConfirming(false);
                  return `Post deleted. Ideas deleted: ${r.deletedIdeaIds.length}; kept: ${r.keptIdeaIds.length}.`;
                })}>Yes, delete permanently</button>
                <button className={btn} autoFocus onClick={() => setConfirming(false)}>Cancel</button>
              </div>
            </div>
          )}
        </>
      )}
      {err && <p role="alert" className="mt-2 text-sm text-[var(--danger)]">{err}</p>}
    </li>
  );
}
