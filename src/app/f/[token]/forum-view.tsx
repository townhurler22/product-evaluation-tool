'use client';

// Public forum (§7.18) at /f/<token>. Anonymous: every call goes to the share API with the password, if any, in a
// header (FH-1201). Its own light theme, scoped to the page (FH-008). Usable from 360 px wide (NFR-07).
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  IMAGE_LONG_EDGE, relativeAge, SORT_LABEL, SORTS, type ForumSort, type PublicForum, type PublicPost, type PublicRoadmapItem, type VoteResult,
} from '@/modules/fh/forum-domain';
import { Markdown, shortDate } from '@/app/fh/_components/ui';

class ShareFailure extends Error {
  constructor(readonly status: number, message: string, readonly field?: string) { super(message); }
}

type Gate = 'ok' | 'password' | 'wrong-password' | 'gone' | 'busy';

const btn = 'inline-flex min-h-8 items-center justify-center gap-1 rounded-md border border-[var(--border)] px-3 py-1 text-sm font-medium hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50';
const btnPrimary = 'inline-flex min-h-8 items-center justify-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1 text-sm font-semibold text-[var(--accent-fg)] hover:opacity-90 disabled:opacity-50';
const field = 'mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm';

export default function ForumView({ token }: { token: string }) {
  const [password, setPassword] = useState<string | null>(null);
  const [gate, setGate] = useState<Gate>('ok');
  const [meta, setMeta] = useState<PublicForum | null>(null);
  const [announce, setAnnounce] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [now] = useState(() => Date.now()); // FH-1205: fixed when the page loads

  // Pure: failures are thrown as ShareFailure; the page decides what a 401, 403 or 404 means.
  const call = useCallback(async <T,>(path: string, init: { method?: string; json?: unknown; form?: FormData } = {}): Promise<T> => {
    const headers: Record<string, string> = {};
    if (password) headers['x-share-password'] = password;
    if (init.json !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`/api/share/${token}/fh/${path}`, {
      method: init.method ?? 'GET', headers, credentials: 'same-origin',
      body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw new ShareFailure(401, 'This forum needs a password.');
    if (res.status === 403 && password && body.code === 'forbidden' && body.message === 'Wrong password.') throw new ShareFailure(403, 'That password is not right.');
    if (res.status === 404) throw new ShareFailure(404, 'This link is not available, or that idea is no longer here.');
    if (!res.ok) throw new ShareFailure(res.status, body.message ?? 'Something went wrong. Try again.', body.details?.field);
    return body as T;
  }, [token, password]);

  useEffect(() => {
    let live = true;
    call<PublicForum>('forum').then((m) => { if (live) { setMeta(m); setGate('ok'); } }).catch((e: ShareFailure) => {
      if (!live) return;
      setGate(e.status === 401 ? 'password' : e.status === 403 ? 'wrong-password' : e.status === 404 ? 'gone' : 'ok');
    });
    return () => { live = false; };
  }, [call]);

  // FH-1203: a signed-in feedback admin is told that actions here run as an anonymous visitor.
  useEffect(() => {
    fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((me) => setIsAdmin(!!me?.isFeedbackAdmin)).catch(() => {});
  }, []);

  if (gate === 'gone') {
    return <Shell><div className="mx-auto max-w-xl px-4 py-16"><h1 className="text-2xl font-bold">This link is not available</h1><p className="mt-2">It may have expired or been switched off. Ask whoever shared it for a new link.</p></div></Shell>;
  }
  if (gate === 'password' || gate === 'wrong-password') {
    return <Shell><PasswordPrompt wrong={gate === 'wrong-password'} onSubmit={(pw) => { setGate('busy'); setPassword(pw); }} /></Shell>;
  }
  if (!meta) return <Shell><p className="px-4 py-16 text-center text-[var(--muted)]" role="status">Loading the forum…</p></Shell>;

  return (
    <Shell>
      {isAdmin && (
        <p role="note" className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-950">You are viewing the forum as a visitor. Anything you do here is anonymous.</p>
      )}
      <header className="border-b border-[var(--border)] bg-[var(--panel)]">
        <div className="mx-auto max-w-6xl px-4 py-6">
          <h1 className="break-words text-2xl font-bold sm:text-3xl">{meta.forum.name}</h1>
          {meta.forum.prompt && <p className="mt-2 max-w-3xl whitespace-pre-wrap break-words text-[var(--muted)]">{meta.forum.prompt}</p>}
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Posts meta={meta} call={call} now={now} onAnnounce={setAnnounce} />
        <Roadmap call={call} />
      </div>
      <footer className="border-t border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--muted)]">
        {/* FH-1210 */}
        Votes and your posts are remembered by this browser. Clearing cookies or using a private window loses them.
      </footer>
      <p role="status" aria-live="polite" className="sr-only">{announce}</p>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="fh-light-scope min-h-screen">{children}</div>;
}

function PasswordPrompt({ wrong, onSubmit }: { wrong: boolean; onSubmit: (pw: string) => void }) {
  return (
    <form className="mx-auto max-w-sm px-4 py-16" onSubmit={(e) => { e.preventDefault(); const pw = String(new FormData(e.currentTarget).get('pw') ?? ''); if (pw) onSubmit(pw); }}>
      <h1 className="text-2xl font-bold">This forum needs a password</h1>
      <label htmlFor="pw" className="mt-4 block text-sm font-medium">Password</label>
      <input id="pw" name="pw" type="password" required autoFocus autoComplete="off" className={field} aria-invalid={wrong || undefined} aria-describedby={wrong ? 'pw-err' : undefined} />
      {wrong && <p id="pw-err" role="alert" className="mt-1 text-sm text-[var(--danger)]">That password is not right.</p>}
      <button type="submit" className={`${btnPrimary} mt-4`}>Open the forum</button>
    </form>
  );
}

type Call = <T>(path: string, init?: { method?: string; json?: unknown; form?: FormData }) => Promise<T>;

// ── posts: sort tabs, status chips, search, composer and list (FH-1204 to FH-1207) ─────────────────────────
function Posts({ meta, call, now, onAnnounce }: { meta: PublicForum; call: Call; now: number; onAnnounce: (t: string) => void }) {
  const [sort, setSort] = useState<ForumSort>('trending');
  const [chips, setChips] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  // The loaded list remembers which query it answers, so "loading" is derived rather than set in an effect.
  const [list, setList] = useState<{ key: string | null; posts: PublicPost[]; next: string | null }>({ key: null, posts: [], next: null });
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  useEffect(() => { const t = setTimeout(() => setQ(query.trim()), 300); return () => clearTimeout(t); }, [query]);

  const params = useCallback((cursor: string | null) => {
    const sp = new URLSearchParams({ sort, now: String(now) });
    for (const c of chips) sp.append('status', c);
    if (q) sp.set('q', q);
    if (cursor) sp.set('cursor', cursor);
    return sp.toString();
  }, [sort, chips, q, now]);

  const key = params(null);
  useEffect(() => {
    let live = true;
    call<{ posts: PublicPost[]; nextCursor: string | null }>(`forum/posts?${key}`)
      .then((r) => { if (live) { setList({ key, posts: r.posts, next: r.nextCursor }); setError(null); } })
      .catch((e) => { if (live) { setList((l) => ({ ...l, key })); setError((e as Error).message); } });
    return () => { live = false; };
  }, [call, key]);
  const loading = list.key !== key || paging;
  const posts = list.posts, next = list.next;
  const setPosts = (fn: (p: PublicPost[]) => PublicPost[]) => setList((l) => ({ ...l, posts: fn(l.posts) }));

  const more = async () => {
    if (!next) return;
    setPaging(true);
    try {
      const r = await call<{ posts: PublicPost[]; nextCursor: string | null }>(`forum/posts?${params(next)}`);
      setList((l) => ({ ...l, posts: [...l.posts, ...r.posts.filter((x) => !l.posts.some((y) => y.id === x.id))], next: r.nextCursor }));
    } catch (e) { setError((e as Error).message); } finally { setPaging(false); }
  };

  // While the server search runs, the loaded posts are filtered at once (FH-1207: case-insensitive substring).
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || needle === q.toLowerCase()) return posts;
    return posts.filter((p) => p.title.toLowerCase().includes(needle) || (p.details ?? '').toLowerCase().includes(needle));
  }, [posts, query, q]);

  const update = (p: PublicPost) => setPosts((all) => all.map((x) => (x.id === p.id ? p : x)));

  const vote = async (p: PublicPost) => {
    const on = !p.hasVoted;
    update({ ...p, hasVoted: on, voteCount: Math.max(0, p.voteCount + (on ? 1 : -1)) }); // FH-1253: optimistic
    try {
      const r = await call<VoteResult>(`posts/${p.id}/vote`, { method: on ? 'POST' : 'DELETE' });
      update({ ...p, hasVoted: r.hasVoted, voteCount: r.voteCount });
      onAnnounce(`${r.hasVoted ? 'Voted for' : 'Vote removed from'} ${p.title}. ${r.voteCount} ${r.voteCount === 1 ? 'vote' : 'votes'}.`);
    } catch (e) {
      update(p);
      onAnnounce((e as Error).message);
    }
  };

  const toggleChip = (c: string) => setChips((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

  return (
    <section aria-labelledby="posts-heading" className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="posts-heading" className="text-xl font-semibold">Ideas</h2>
        {meta.can.submit && !composing && <button type="button" className={btnPrimary} onClick={() => setComposing(true)}>Suggest an idea</button>}
      </div>

      {composing && (
        <Composer meta={meta} call={call} onCancel={() => setComposing(false)}
          onVoteInstead={async (p) => { setComposing(false); if (!p.hasVoted) await vote(p); }}
          onPosted={(p) => { setPosts((all) => [p, ...all.filter((x) => x.id !== p.id)]); setComposing(false); onAnnounce('Thanks. Your idea is posted.'); }} />
      )}

      <div className="mt-4 space-y-3">
        <div role="group" aria-label="Sort ideas" className="flex flex-wrap gap-1">
          {SORTS.map((s) => (
            <button key={s} type="button" aria-pressed={sort === s} onClick={() => setSort(s)}
              className={`${btn} aria-pressed:border-[var(--accent)] aria-pressed:bg-[var(--accent)] aria-pressed:text-[var(--accent-fg)]`}>{SORT_LABEL[s]}</button>
          ))}
        </div>
        <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1">
          {meta.statusChips.map((c) => (
            <button key={c} type="button" aria-pressed={chips.includes(c)} onClick={() => toggleChip(c)}
              className="min-h-8 rounded-full border border-[var(--border)] px-3 py-1 text-xs font-medium aria-pressed:border-[var(--accent)] aria-pressed:bg-indigo-50 aria-pressed:text-indigo-900">
              {chips.includes(c) ? '✓ ' : ''}{c}
            </button>
          ))}
        </div>
        <label className="block text-sm">
          <span className="sr-only">Search ideas</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search ideas" maxLength={200} className={field} />
        </label>
      </div>

      {error && <p role="alert" className="mt-4 text-sm text-[var(--danger)]">{error}</p>}
      <ul className="mt-4 space-y-3" aria-busy={loading}>
        {shown.map((p) => <PostCard key={p.id} post={p} now={now} canVote={meta.can.vote} canEdit={meta.can.submit} call={call} onVote={() => vote(p)} onEdited={update} />)}
      </ul>
      {!loading && !shown.length && <p className="mt-6 text-center text-[var(--muted)]">{q || chips.length ? 'No ideas match.' : 'No ideas yet. Be the first to suggest one.'}</p>}
      {loading && <p role="status" className="mt-4 text-center text-sm text-[var(--muted)]">Loading…</p>}
      {next && !loading && <div className="mt-4 text-center"><button type="button" className={btn} onClick={more}>Show more ideas</button></div>}
    </section>
  );
}

function StatusPill({ label, kind }: { label: string; kind: PublicPost['statusKind'] }) {
  const tone = kind === 'complete' ? 'bg-green-100 text-green-900 border-green-300' : kind === 'closed' ? 'bg-gray-200 text-gray-800 border-gray-300' : 'bg-indigo-50 text-indigo-900 border-indigo-200';
  return <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${tone}`}>{label}</span>;
}

function PostCard({ post, now, canVote, canEdit, call, onVote, onEdited }: {
  post: PublicPost; now: number; canVote: boolean; canEdit: boolean; call: Call; onVote: () => void; onEdited: (p: PublicPost) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [images, setImages] = useState<{ id: string; url: string }[] | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  const titleId = `post-${post.id}`;
  const votes = `${post.voteCount} ${post.voteCount === 1 ? 'vote' : 'votes'}`;
  return (
    <li className={`flex gap-3 rounded-lg border border-[var(--border)] p-3 ${post.statusKind === 'closed' ? 'bg-gray-50' : 'bg-[var(--bg)]'}`} aria-labelledby={titleId}>
      <div className="flex w-14 shrink-0 flex-col items-center">
        {canVote ? (
          <button type="button" onClick={onVote} aria-pressed={post.hasVoted}
            aria-label={`${post.hasVoted ? 'Remove your vote from' : 'Vote for'} ${post.title}, ${votes}`}
            className="flex min-h-12 w-14 flex-col items-center justify-center rounded-md border border-[var(--border)] text-sm font-semibold hover:border-[var(--accent)] aria-pressed:border-[var(--accent)] aria-pressed:bg-[var(--accent)] aria-pressed:text-[var(--accent-fg)]">
            <span aria-hidden>▲</span><span className="tabular-nums">{post.voteCount}</span>
          </button>
        ) : (
          <span className="flex min-h-12 w-14 flex-col items-center justify-center rounded-md border border-[var(--border)] text-sm font-semibold" aria-label={votes}>
            <span aria-hidden>▲</span><span className="tabular-nums">{post.voteCount}</span>
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <EditPost post={post} call={call} onCancel={() => setEditing(false)} onSaved={(p) => { onEdited(p); setEditing(false); }} />
        ) : (
          <>
            <h3 id={titleId} className="break-words font-semibold">{post.title}</h3>
            {post.details && <div className="mt-1"><Markdown text={post.details} /></div>}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
              <StatusPill label={post.statusLabel} kind={post.statusKind} />
              <span>{relativeAge(post.createdAt, now)}</span>
              {post.isMine && <span className="rounded-full border border-[var(--border)] px-2 py-0.5">Your idea</span>}
              {post.imageCount > 0 && !images && (
                <button type="button" className="min-h-6 underline" onClick={async () => {
                  try { setImages((await call<{ images: { id: string; url: string }[] }>(`posts/${post.id}/images`)).images); } catch (e) { setImgError((e as Error).message); }
                }}>Show {post.imageCount === 1 ? 'screenshot' : `${post.imageCount} screenshots`}</button>
              )}
              {post.isMine && canEdit && <button type="button" className="min-h-6 underline" onClick={() => setEditing(true)}>Edit</button>}
            </div>
            {imgError && <p role="alert" className="mt-1 text-xs text-[var(--danger)]">{imgError}</p>}
            {images && (
              <ul className="mt-2 flex flex-wrap gap-2">
                {images.map((img, i) => (
                  <li key={img.id}>
                    <a href={img.url} target="_blank" rel="noopener noreferrer" className="block">
                      {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL, not optimisable */}
                      <img src={img.url} alt={`Screenshot ${i + 1} for ${post.title}`} className="h-24 w-auto max-w-full rounded border border-[var(--border)] object-cover" referrerPolicy="no-referrer" />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function EditPost({ post, call, onCancel, onSaved }: { post: PublicPost; call: Call; onCancel: () => void; onSaved: (p: PublicPost) => void }) {
  const [title, setTitle] = useState(post.title);
  const [details, setDetails] = useState(post.details ?? '');
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { onSaved((await call<{ post: PublicPost }>(`posts/${post.id}`, { method: 'PATCH', json: { title, details: details || null } })).post); }
    catch (x) { const f = x as ShareFailure; setErr({ field: f.field, message: f.status === 404 ? 'This idea can no longer be edited from here.' : f.message }); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-2" aria-label="Edit your idea">
      <label className="block text-sm font-medium">Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} className={field}
          aria-invalid={err?.field === 'title' || undefined} aria-describedby={err?.field === 'title' ? `e-${post.id}` : undefined} />
      </label>
      <label className="block text-sm font-medium">Details
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={4} maxLength={5000} className={field}
          aria-invalid={err?.field === 'details' || undefined} aria-describedby={err?.field === 'details' ? `e-${post.id}` : undefined} />
      </label>
      {err && <p id={`e-${post.id}`} role="alert" className="text-sm text-[var(--danger)]">{err.message}</p>}
      <div className="flex gap-2"><button type="submit" className={btnPrimary} disabled={busy}>Save</button><button type="button" className={btn} onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

// ── composer (FH-1211) ───────────────────────────────────────────────────────────────────────────────────────
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Downscales to 2,560 px on the long edge in the browser; re-encodes only when it must. */
async function prepareImage(file: File, maxBytes: number): Promise<Blob> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error(`${file.name} is not a PNG, JPEG or WebP image.`);
  const bitmap = await createImageBitmap(file);
  const long = Math.max(bitmap.width, bitmap.height);
  if (long <= IMAGE_LONG_EDGE && file.size <= maxBytes) { bitmap.close(); return file; }
  const scale = Math.min(1, IMAGE_LONG_EDGE / long);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = (type: string, quality?: number) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, quality));
  let blob = await encode(file.type === 'image/png' ? 'image/png' : file.type, 0.9);
  if (!blob || blob.size > maxBytes) blob = await encode('image/jpeg', 0.85);
  if (!blob || blob.size > maxBytes) throw new Error(`${file.name} is still larger than 2 MB after resizing.`);
  return blob;
}

function Composer({ meta, call, onCancel, onPosted, onVoteInstead }: {
  meta: PublicForum; call: Call; onCancel: () => void; onPosted: (p: PublicPost) => void; onVoteInstead: (p: PublicPost) => void;
}) {
  const [title, setTitle] = useState('');
  const [similar, setSimilar] = useState<PublicPost[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);

  // Similar posts while typing a title of 3 or more characters (trigram similarity, most votes first).
  const typed = title.trim();
  useEffect(() => {
    if (typed.length < 3) return;
    const h = setTimeout(() => {
      call<{ posts: PublicPost[] }>(`forum/similar?title=${encodeURIComponent(typed)}`).then((r) => setSimilar(r.posts)).catch(() => setSimilar([]));
    }, 350);
    return () => clearTimeout(h);
  }, [typed, call]);
  const similarShown = typed.length >= 3 ? similar : [];

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErr(null);
    const form = new FormData(e.currentTarget);
    form.delete('images');
    setBusy(true);
    try {
      if (files.length > meta.limits.images) throw Object.assign(new Error(`Attach at most ${meta.limits.images} screenshots.`), { field: 'images' });
      for (const f of files) form.append('images', await prepareImage(f, meta.limits.imageBytes), f.name);
      const r = await call<{ post: PublicPost }>('posts', { method: 'POST', form });
      onPosted(r.post);
    } catch (x) {
      const f = x as ShareFailure & { field?: string };
      setErr({ field: f.field, message: f.message });
    } finally { setBusy(false); }
  };

  const errFor = (name: string) => (err?.field === name ? { 'aria-invalid': true as const, 'aria-describedby': 'composer-err' } : {});
  return (
    <form onSubmit={submit} className="mt-4 space-y-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3" aria-label="Suggest an idea" noValidate={false}>
      <label className="block text-sm font-medium">Title (required)
        <input ref={titleRef} name="title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={meta.limits.titleMax} className={field} {...errFor('title')} />
      </label>
      {similarShown.length > 0 && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] p-2">
          <p className="text-sm font-medium" id="similar-h">Similar ideas already here</p>
          <ul aria-labelledby="similar-h" className="mt-1 space-y-1">
            {similarShown.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0 break-words">{p.title} <span className="text-[var(--muted)]">({p.voteCount} {p.voteCount === 1 ? 'vote' : 'votes'})</span></span>
                {meta.can.vote && <button type="button" className={btn} disabled={p.hasVoted} onClick={() => onVoteInstead(p)}>{p.hasVoted ? 'You voted' : 'Vote for this instead'}</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <label className="block text-sm font-medium">Details
        <textarea name="details" rows={4} maxLength={meta.limits.detailsMax} className={field} {...errFor('details')} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium">Email (optional)
          <input name="email" type="email" maxLength={meta.limits.emailMax} autoComplete="email" className={field} {...errFor('email')} />
          <span className="mt-1 block text-xs font-normal text-[var(--muted)]">Only the team sees it. It is not checked.</span>
        </label>
        <label className="block text-sm font-medium">Your name (optional)
          <input name="displayName" maxLength={meta.limits.displayNameMax} autoComplete="name" className={field} {...errFor('displayName')} />
        </label>
      </div>
      <label className="block text-sm font-medium">Screenshots (up to {meta.limits.images}, PNG, JPEG or WebP)
        <input type="file" name="images" accept={IMAGE_TYPES.join(',')} multiple className="mt-1 block w-full text-sm" {...errFor('images')}
          onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, meta.limits.images))} />
      </label>
      {err && <p id="composer-err" role="alert" className="text-sm text-[var(--danger)]">{err.message}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={btnPrimary} disabled={busy}>{busy ? 'Posting…' : 'Post idea'}</button>
        <button type="button" className={btn} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ── public roadmap (FH-1208) ─────────────────────────────────────────────────────────────────────────────────
function Roadmap({ call }: { call: Call }) {
  const [batches, setBatches] = useState<{ releaseDate: string | null; items: PublicRoadmapItem[] }[] | null>(null);
  useEffect(() => {
    call<{ batches: { releaseDate: string | null; items: PublicRoadmapItem[] }[] }>('forum/roadmap').then((r) => setBatches(r.batches)).catch(() => setBatches([]));
  }, [call]);
  if (!batches?.length) return null; // hidden when empty
  const today = new Date().toISOString().slice(0, 10);
  return (
    <aside aria-labelledby="roadmap-h" className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-auto">
      <h2 id="roadmap-h" className="text-xl font-semibold">Roadmap</h2>
      <div className="mt-3 space-y-3">
        {batches.map((b) => (
          <details key={b.releaseDate ?? 'undated'} open={!b.releaseDate || b.releaseDate >= today} className="rounded-lg border border-[var(--border)] p-2">
            <summary className="min-h-6 cursor-pointer text-sm font-semibold">
              {b.releaseDate ? `${b.releaseDate < today ? 'Released' : 'Release'} ${shortDate(b.releaseDate)}` : 'Not yet scheduled'} ({b.items.length})
            </summary>
            <ul className="mt-2 space-y-2">
              {b.items.map((i) => (
                <li key={i.id} className="text-sm">
                  <p className="break-words font-medium">{i.title}</p>
                  {i.summary && <p className="mt-0.5 whitespace-pre-wrap break-words text-[var(--muted)]">{i.summary}</p>}
                  <p className="mt-1 flex flex-wrap gap-2 text-xs text-[var(--muted)]">
                    <StatusPill label={i.statusLabel} kind={null} />
                    <span>{shortDate(i.startDate)}{i.dueDate ? ` to ${shortDate(i.dueDate)}` : ''}</span>
                    <span>{i.voterCount} {i.voterCount === 1 ? 'voter' : 'voters'}</span>
                  </p>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </aside>
  );
}
