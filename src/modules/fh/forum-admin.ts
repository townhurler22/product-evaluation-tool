// Forum administration (§7.17): forums, status visibility, the posts list with voters, post edit and delete, and
// team votes. Feedback admins only; permanent delete needs the post-delete grant (OD-03). Voter identities appear
// only in `listForumPosts` (FH-1106).
import { sql } from 'kysely';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { audit, deleteFiles, newId, type Principal } from '@/modules/core/service';
import { STATUS_KEYS, type StatusKey } from './domain';
import { ADMIN_POSTS_PAGE, slugify, VOTERS_SHOWN, type VoteResult } from './forum-domain';
import { refreshPostIdeas } from './forum-public';
import { publishIdeas, publishRemoved } from './live';
import { rowsByIds } from './rows';
import { translateDbError, type Db } from './store';

const CONFLICT_SLUG = (name: string) => new ApiError('conflict', `A forum called ${name} already exists`, { field: 'name' });

async function inTx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  try { return await getDb().transaction().execute(fn); } catch (e) { throw translateDbError(e); }
}

const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === '23505' || /duplicate key|unique/i.test(String((e as Error)?.message));

// ── forums (FH-1101 to FH-1103) ──────────────────────────────────────────────────────────────────────────────
export interface ForumAdminRow {
  id: string; name: string; slug: string; prompt: string | null; isArchived: boolean; isMain: boolean;
  postCount: number; createdAt: string;
  links: { id: string; capabilities: string[]; hasPassword: boolean; expiresAt: string | null; maxUses: number | null; useCount: number; revokedAt: string | null; createdAt: string }[];
}

const FORUM_COLUMNS = sql`
  f.id::text, f.name, f.slug, f.submission_prompt AS prompt, f.is_archived AS "isArchived", f.is_main AS "isMain",
  (SELECT count(*)::int FROM fh_post p WHERE p.forum_id = f.id) AS "postCount", f.created_at AS "createdAt",
  COALESCE((SELECT json_agg(json_build_object('id', l.id, 'capabilities', l.capabilities, 'hasPassword', l.password_hash IS NOT NULL,
      'expiresAt', l.expires_at, 'maxUses', l.max_uses, 'useCount', l.use_count, 'revokedAt', l.revoked_at, 'createdAt', l.created_at)
      ORDER BY l.created_at DESC)
    FROM core_share_link l WHERE l.module = 'fh' AND l.target_kind = 'forum' AND l.target_id = f.id), '[]') AS links`;

/** FH-1101: archived last, newest first, with post counts and share links. One statement. */
export async function listForums(): Promise<ForumAdminRow[]> {
  const { rows } = await sql<ForumAdminRow>`SELECT ${FORUM_COLUMNS} FROM fh_forum f ORDER BY f.is_archived, f.created_at DESC, f.id`.execute(getDb());
  return rows;
}

export async function getForum(db: Db, id: string): Promise<ForumAdminRow> {
  const { rows } = await sql<ForumAdminRow>`SELECT ${FORUM_COLUMNS} FROM fh_forum f WHERE f.id = ${id}::uuid`.execute(db);
  if (!rows[0]) throw new ApiError('not_found', 'Not found.');
  return rows[0];
}

function slugFor(name: string): string {
  const slug = slugify(name);
  if (!slug) throw new ApiError('validation', 'The name needs at least one letter or digit.', { field: 'name' });
  return slug;
}

/** FH-1102. ≤ 3 statements. */
export async function createForum(p: Principal, input: { name: string; prompt: string | null }) {
  const slug = slugFor(input.name);
  const id = newId();
  const res = await sql<{ id: string }>`
    INSERT INTO fh_forum (id, name, slug, submission_prompt, created_by)
    VALUES (${id}, ${input.name}, ${slug}, ${input.prompt}, ${p.userId}) ON CONFLICT (slug) DO NOTHING RETURNING id::text`.execute(getDb());
  if (!res.rows.length) throw CONFLICT_SLUG(input.name);
  await audit({ actorKind: 'user', actorId: p.userId, action: 'fh.forum.create', targetKind: 'forum', targetId: id });
  return getForum(getDb(), id);
}

export interface ForumPatch { name?: string; prompt?: string | null; archived?: boolean; main?: boolean }

/**
 * FH-1103: rename (re-slug, clash check), prompt, archive, main. Archiving clears main; an archived forum cannot be
 * made main (409); making a forum main clears the previous main in the same transaction. Archiving keeps the links
 * (the resolver refuses archived forums). ≤ 6 statements.
 */
export async function updateForum(p: Principal, id: string, patch: ForumPatch) {
  if (!Object.keys(patch).length) throw new ApiError('validation', 'Change at least one field.');
  try {
    return await inTx(async (tx) => {
      const { rows: [cur] } = await sql<{ name: string; slug: string; prompt: string | null; is_archived: boolean; is_main: boolean }>`
        SELECT name, slug, submission_prompt AS prompt, is_archived, is_main FROM fh_forum WHERE id = ${id}::uuid FOR UPDATE`.execute(tx);
      if (!cur) throw new ApiError('not_found', 'Not found.');
      const name = patch.name ?? cur.name;
      const slug = patch.name !== undefined && patch.name !== cur.name ? slugFor(patch.name) : cur.slug;
      const archived = patch.archived ?? cur.is_archived;
      let main = patch.main ?? cur.is_main;
      if (patch.main && archived) throw new ApiError('conflict', 'An archived forum cannot be the main forum.', { field: 'main' });
      if (archived) main = false;
      if (main && !cur.is_main) await sql`UPDATE fh_forum SET is_main = false WHERE is_main AND id <> ${id}::uuid`.execute(tx);
      await sql`UPDATE fh_forum SET name = ${name}, slug = ${slug},
          submission_prompt = ${patch.prompt !== undefined ? patch.prompt : cur.prompt},
          is_archived = ${archived}, is_main = ${main}
        WHERE id = ${id}::uuid`.execute(tx);
      await audit({ actorKind: 'user', actorId: p.userId, action: 'fh.forum.update', targetKind: 'forum', targetId: id,
        details: { fields: Object.keys(patch) } }, tx);
      return getForum(tx, id);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw CONFLICT_SLUG(patch.name ?? '');
    throw e;
  }
}

// ── status visibility (FH-1105) ─────────────────────────────────────────────────────────────────────────────
export interface StatusConfigRow { statusKey: StatusKey; isPublic: boolean; label: string | null; kind: 'complete' | 'closed' | null }

/** Every status of both workflows; missing rows read as not public (never inserted on read). One statement. */
export async function readStatusConfig(db: Db = getDb()): Promise<StatusConfigRow[]> {
  const { rows } = await sql<{ status_key: string; is_public: boolean; public_label: string | null; public_kind: 'complete' | 'closed' | null }>`
    SELECT status_key, is_public, public_label, public_kind FROM fh_status_config`.execute(db);
  const byKey = new Map(rows.map((r) => [r.status_key, r]));
  return STATUS_KEYS.map((k) => {
    const r = byKey.get(k);
    return { statusKey: k, isPublic: r?.is_public ?? false, label: r?.public_label ?? null, kind: r?.public_kind ?? null };
  });
}

/** Upserts the given rows; the order sent is the chip order. ≤ 4 statements. */
export async function writeStatusConfig(p: Principal, items: StatusConfigRow[]) {
  const keys = new Set<string>();
  for (const i of items) {
    if (keys.has(i.statusKey)) throw new ApiError('validation', 'Each status may appear once.', { field: 'items' });
    keys.add(i.statusKey);
  }
  const payload = JSON.stringify(items.map((i, n) => ({ k: i.statusKey, p: i.isPublic, l: i.label, kind: i.kind, o: n })));
  await inTx(async (tx) => {
    await sql`
      INSERT INTO fh_status_config AS c (status_key, is_public, public_label, public_kind, sort_order)
      SELECT v.k, v.p, v.l, v.kind, v.o FROM jsonb_to_recordset(${payload}::jsonb) AS v(k text, p bool, l text, kind text, o int)
      ON CONFLICT (status_key) DO UPDATE SET is_public = EXCLUDED.is_public, public_label = EXCLUDED.public_label,
        public_kind = EXCLUDED.public_kind, sort_order = EXCLUDED.sort_order`.execute(tx);
    await audit({ actorKind: 'user', actorId: p.userId, action: 'fh.status_config.update', details: { keys: [...keys] } }, tx);
  });
  return readStatusConfig();
}

// ── posts (FH-1106 to FH-1108, FH-1254) ─────────────────────────────────────────────────────────────────────
export interface AdminPost {
  id: string; title: string; details: string | null; voteCount: number; createdAt: string; updatedAt: string; imageCount: number;
  author: string | null; publishedBy: string | null;
  /** Up to 200: name or email, "<staff name> (team)" for staff votes, else "Anonymous". */
  voters: string[];
  teamVoted: boolean;
  ideas: { id: string; number: number; title: string; status: string | null; bugStatus: string | null }[];
}

/** FH-1106: most votes first, then newest; 50 per page; the only place voter identities are shown. One statement. */
export async function listForumPosts(p: Principal, forumId: string, offset: number) {
  const { rows } = await sql<AdminPost & { total: number; forum_ok: boolean }>`
    WITH f AS (SELECT id FROM fh_forum WHERE id = ${forumId}::uuid),
    page AS (
      SELECT p.*, count(*) OVER () AS total FROM fh_post p WHERE p.forum_id = (SELECT id FROM f)
      ORDER BY p.vote_count DESC, p.created_at DESC, p.id LIMIT ${ADMIN_POSTS_PAGE} OFFSET ${offset})
    SELECT EXISTS (SELECT 1 FROM f) AS forum_ok, page.id::text, page.title, page.details, page.vote_count AS "voteCount",
      page.created_at AS "createdAt", page.updated_at AS "updatedAt", page.image_count AS "imageCount", page.total::int AS total,
      (SELECT COALESCE(pe.display_name, pe.email, 'Anonymous') FROM core_person pe WHERE pe.id = page.author_person_id) AS author,
      (SELECT COALESCE(u.full_name, u.email) FROM core_user u WHERE u.id = page.author_user_id) AS "publishedBy",
      ARRAY(SELECT CASE WHEN v.user_id IS NOT NULL THEN COALESCE(u.full_name, u.email) || ' (team)'
                        ELSE COALESCE(pe.display_name, pe.email, 'Anonymous') END
            FROM fh_vote v LEFT JOIN core_person pe ON pe.id = v.person_id LEFT JOIN core_user u ON u.id = v.user_id
            WHERE v.post_id = page.id ORDER BY v.created_at, v.id LIMIT ${VOTERS_SHOWN}) AS voters,
      EXISTS (SELECT 1 FROM fh_vote v WHERE v.post_id = page.id AND v.user_id = ${p.userId}::uuid) AS "teamVoted",
      COALESCE((SELECT json_agg(json_build_object('id', i.id, 'number', i.number, 'title', i.title, 'status', i.status, 'bugStatus', i.bug_status)
                 ORDER BY ip.created_at, i.id)
                FROM fh_idea_post ip JOIN fh_idea i ON i.id = ip.idea_id AND i.merged_into_id IS NULL WHERE ip.post_id = page.id), '[]') AS ideas
    FROM (SELECT 1) one LEFT JOIN page ON true
    ORDER BY page.vote_count DESC, page.created_at DESC, page.id`.execute(getDb());
  if (!rows.length || !rows[0].forum_ok) throw new ApiError('not_found', 'Not found.');
  const total = rows[0].id ? Number(rows[0].total) : 0;
  const posts: AdminPost[] = rows.filter((r) => r.id).map((r) => ({
    id: r.id, title: r.title, details: r.details, voteCount: Number(r.voteCount), createdAt: r.createdAt, updatedAt: r.updatedAt,
    imageCount: Number(r.imageCount), author: r.author, publishedBy: r.publishedBy, voters: r.voters, teamVoted: r.teamVoted, ideas: r.ideas,
  }));
  return { posts, total, nextOffset: offset + ADMIN_POSTS_PAGE < total ? offset + ADMIN_POSTS_PAGE : null };
}

/** FH-1107: title and details, sanitised as a customer post; the linked idea is not changed. ≤ 2 statements. */
export async function editPost(p: Principal, forumId: string, postId: string, text: { title: string; details: string | null }) {
  const res = await sql`UPDATE fh_post SET title = ${text.title}, details = ${text.details}, updated_at = now()
    WHERE id = ${postId}::uuid AND forum_id = ${forumId}::uuid`.execute(getDb());
  if (!Number(res.numAffectedRows ?? 0)) throw new ApiError('not_found', 'Not found.');
  await audit({ actorKind: 'user', actorId: p.userId, action: 'fh.post.edit', targetKind: 'post', targetId: postId });
  return { post: { id: postId, title: text.title, details: text.details } };
}

/**
 * FH-1108 (D-34): permanently deletes the post, its votes, vote events, links and files. A formerly linked idea is
 * deleted only if untouched, judged on both workflows: status or bug status Open, no owner, no start or due date, no
 * other linked post, no manual insight, no comments. Files of deleted insights go after commit. ≤ 7 statements in
 * the transaction, then file removal and the changed rows.
 */
export async function deletePost(p: Principal, forumId: string, postId: string) {
  if (!p.canDeletePosts) throw new ApiError('forbidden', 'Deleting forum posts needs the post-delete permission.');
  let deleted: string[] = [], kept: string[] = [], fileIds: string[] = [];
  await inTx(async (tx) => {
    const { rows: [post] } = await sql<{ id: string }>`
      SELECT id::text FROM fh_post WHERE id = ${postId}::uuid AND forum_id = ${forumId}::uuid FOR UPDATE`.execute(tx);
    if (!post) throw new ApiError('not_found', 'Not found.');
    const { rows: ideas } = await sql<{ id: string; untouched: boolean }>`
      SELECT i.id::text,
        ((i.status = 'OPEN' OR i.bug_status = 'OPEN') AND i.owner_id IS NULL AND i.start_date IS NULL AND i.due_date IS NULL
         AND NOT EXISTS (SELECT 1 FROM fh_idea_post o WHERE o.idea_id = i.id AND o.post_id <> ${postId}::uuid)
         AND NOT EXISTS (SELECT 1 FROM fh_insight s WHERE s.idea_id = i.id AND s.source = 'MANUAL')
         AND NOT EXISTS (SELECT 1 FROM fh_comment c WHERE c.idea_id = i.id)) AS untouched
      FROM fh_idea_post ip JOIN fh_idea i ON i.id = ip.idea_id AND i.merged_into_id IS NULL
      WHERE ip.post_id = ${postId}::uuid FOR UPDATE OF i`.execute(tx);
    deleted = ideas.filter((i) => i.untouched).map((i) => i.id);
    kept = ideas.filter((i) => !i.untouched).map((i) => i.id);
    const files = await sql<{ id: string }>`
      SELECT f.id::text FROM core_file f WHERE f.module = 'fh' AND (
        (f.owner_kind = 'post' AND f.owner_id = ${postId})
        OR (f.owner_kind = 'insight' AND f.owner_id IN (SELECT id::text FROM fh_insight WHERE idea_id = ANY(${deleted}::uuid[]))))`.execute(tx);
    fileIds = files.rows.map((r) => r.id);
    if (deleted.length) await sql`DELETE FROM fh_idea WHERE id = ANY(${deleted}::uuid[])`.execute(tx);
    // Votes and links cascade with the post; vote events have no foreign key and go explicitly.
    await sql`WITH e AS (DELETE FROM fh_vote_event WHERE post_id = ${postId}::uuid) DELETE FROM fh_post WHERE id = ${postId}::uuid`.execute(tx);
    if (kept.length) await sql`SELECT fh_rollup_refresh(${kept}::uuid[])`.execute(tx);
    await audit({ actorKind: 'user', actorId: p.userId, action: 'fh.post.delete', targetKind: 'post', targetId: postId,
      details: { forumId, deletedIdeaIds: deleted, keptIdeaIds: kept } }, tx);
  });
  const filesRemoved = fileIds.length ? await deleteFiles(fileIds) : 0; // never fails the delete (ARC-29)
  publishRemoved(deleted.map((id) => ({ id })));
  if (kept.length) publishIdeas(await rowsByIds(getDb(), kept));
  return { post: { id: postId }, deletedIdeaIds: deleted, keptIdeaIds: kept, filesRemoved };
}

/**
 * FH-1254, OD-14 (a): "Vote as team member". Stored as a user vote; counts in vote totals, not in user counts.
 * ≤ 3 statements.
 */
export async function teamVote(p: Principal, forumId: string, postId: string, on: boolean): Promise<VoteResult> {
  return inTx(async (tx) => {
    const { rows: [r] } = on
      ? await sql<{ found: boolean; changed: boolean; vote_count: number | null }>`
        WITH po AS (SELECT id, vote_count FROM fh_post WHERE id = ${postId}::uuid AND forum_id = ${forumId}::uuid),
        ins AS (INSERT INTO fh_vote (id, post_id, user_id) SELECT ${newId()}::uuid, id, ${p.userId}::uuid FROM po ON CONFLICT DO NOTHING RETURNING post_id),
        upd AS (UPDATE fh_post SET vote_count = vote_count + 1 WHERE id IN (SELECT post_id FROM ins) RETURNING vote_count),
        ev AS (INSERT INTO fh_vote_event (id, post_id, action, user_id) SELECT ${newId()}::uuid, post_id, 'UP', ${p.userId}::uuid FROM ins)
        SELECT EXISTS (SELECT 1 FROM po) AS found, EXISTS (SELECT 1 FROM ins) AS changed,
               COALESCE((SELECT vote_count FROM upd), (SELECT vote_count FROM po)) AS vote_count`.execute(tx)
      : await sql<{ found: boolean; changed: boolean; vote_count: number | null }>`
        WITH po AS (SELECT id, vote_count FROM fh_post WHERE id = ${postId}::uuid AND forum_id = ${forumId}::uuid),
        del AS (DELETE FROM fh_vote WHERE post_id IN (SELECT id FROM po) AND user_id = ${p.userId}::uuid RETURNING post_id),
        upd AS (UPDATE fh_post SET vote_count = GREATEST(vote_count - 1, 0) WHERE id IN (SELECT post_id FROM del) RETURNING vote_count),
        ev AS (INSERT INTO fh_vote_event (id, post_id, action, user_id) SELECT ${newId()}::uuid, post_id, 'UNDO', ${p.userId}::uuid FROM del)
        SELECT EXISTS (SELECT 1 FROM po) AS found, EXISTS (SELECT 1 FROM del) AS changed,
               COALESCE((SELECT vote_count FROM upd), (SELECT vote_count FROM po)) AS vote_count`.execute(tx);
    if (!r.found) throw new ApiError('not_found', 'Not found.');
    if (r.changed) await refreshPostIdeas(tx, postId);
    return { postId, hasVoted: on, voteCount: Number(r.vote_count), changed: r.changed };
  });
}
