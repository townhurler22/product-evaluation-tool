// Public forum share handlers (§7.18, §11.3). Every function takes the resolved ShareContext and filters on its
// forum id (INV-15, SEC-10). Responses use the public types in forum-domain.ts only (INV-16): no author, voter,
// internal status, theme, owner, comment or requester identity ever leaves these functions.
import { sql, type RawBuilder } from 'kysely';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import {
  discardUploads, enqueue, insertFileRows, newId, newVisitorCookie, normaliseEmail, prepareUpload, signFileUrls,
  sha256, type PreparedFile, type ShareContext, type ShareLinkRow, type ResolvedTarget,
} from '@/modules/core/service';
import {
  FORUM_PAGE, POST_DETAILS_MAX, POST_EMAIL_MAX, POST_IMAGE_BYTES, POST_IMAGES_MAX, POST_NAME_MAX, POST_TITLE_MAX,
  releaseBatches, type ForumSort, type PublicForum, type PublicPost, type PublicRoadmapItem, type VoteResult,
} from './forum-domain';
import { drainSoon } from './live';
import { sanitise } from './text';
import type { Db } from './store';

type Frag = RawBuilder<unknown>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A malformed post id is simply not found (the caller answers the share 404). */
export const isPostId = (v: string | undefined): v is string => !!v && UUID_RE.test(v);

// ── resolver (SEC-08): the forum exists, is not archived, and the link's creator is still an active feedback admin ──
export async function resolveForumShare(link: ShareLinkRow): Promise<ResolvedTarget | null> {
  if (link.target_kind !== 'forum' || link.creator_status !== 'ACTIVE') return null;
  const { rows } = await sql<{ ok: boolean }>`
    SELECT true AS ok FROM fh_forum f, core_user u LEFT JOIN fh_grant g ON g.user_id = u.id
    WHERE f.id = ${link.target_id}::uuid AND NOT f.is_archived
      AND u.id = ${link.created_by}::uuid AND u.status = 'ACTIVE'
      AND (u.role IN ('ADMIN','PRODUCT') OR g.role = 'ADMIN')`.execute(getDb());
  return rows[0]?.ok ? { targetId: link.target_id, grant: ['VIEW', 'SUBMIT', 'VOTE'] } : null;
}

// ── shared SQL ───────────────────────────────────────────────────────────────────────────────────────────────
/** The label shown for anything not public (core_setting `forum.default_label`, "Under consideration"). */
const DEFAULT_LABEL = sql`COALESCE((SELECT value #>> '{}' FROM core_setting WHERE key = 'forum.default_label'), 'Under consideration')`;

/**
 * A post's public status: the earliest-linked live idea's status, if that status is public (FH-1105). Only the
 * label and kind leave the database; the internal status never does (INV-16).
 */
const POST_STATUS = sql`LEFT JOIN LATERAL (
    SELECT CASE WHEN c.is_public THEN c.public_label END AS label, CASE WHEN c.is_public THEN c.public_kind END AS kind
    FROM fh_idea_post ip JOIN fh_idea i ON i.id = ip.idea_id AND i.merged_into_id IS NULL
    LEFT JOIN fh_status_config c ON c.status_key = CASE WHEN i.status IS NOT NULL THEN 'IDEA_' || i.status ELSE 'BUG_' || i.bug_status END
    WHERE ip.post_id = p.id ORDER BY ip.created_at, ip.idea_id LIMIT 1) st ON true`;

interface PostQuery { where?: Frag; order: Frag; limit: number; offset?: number; labels?: string[] | null }

/** Public posts of one forum in one statement, with this visitor's votes and own posts. */
async function publicPosts(db: Db, forumId: string, cookieHash: string | null, q: PostQuery): Promise<PublicPost[]> {
  const labels = q.labels?.length ? q.labels : null;
  const { rows } = await sql<PublicPost & { createdAt: Date | string }>`
    WITH me AS (SELECT id FROM core_person WHERE cookie_token_hash = ${cookieHash}::text),
    d AS (SELECT ${DEFAULT_LABEL} AS label),
    posts AS (
      SELECT p.id, p.title, p.details, p.vote_count, p.created_at, p.image_count, p.author_person_id,
             COALESCE(st.label, (SELECT label FROM d)) AS status_label, st.kind AS status_kind
      FROM fh_post p ${POST_STATUS}
      WHERE p.forum_id = ${forumId}::uuid ${q.where ? sql`AND ${q.where}` : sql``})
    SELECT id::text, title, details, vote_count AS "voteCount", created_at AS "createdAt",
           EXISTS (SELECT 1 FROM fh_vote v, me WHERE v.post_id = posts.id AND v.person_id = me.id) AS "hasVoted",
           status_label AS "statusLabel", status_kind AS "statusKind",
           COALESCE(author_person_id = (SELECT id FROM me), false) AS "isMine", image_count AS "imageCount"
    FROM posts
    WHERE ${labels}::text[] IS NULL OR status_label = ANY(${labels}::text[])
    ORDER BY ${q.order}
    LIMIT ${q.limit} OFFSET ${q.offset ?? 0}`.execute(db);
  return rows.map((r) => ({
    id: r.id, title: r.title, details: r.details, voteCount: Number(r.voteCount),
    createdAt: new Date(r.createdAt).toISOString(), hasVoted: r.hasVoted, statusLabel: r.statusLabel,
    statusKind: r.statusKind ?? null, isMine: r.isMine, imageCount: Number(r.imageCount),
  }));
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, '\\$&');

// ── reads (VIEW) ─────────────────────────────────────────────────────────────────────────────────────────────
/** GET forum: name, prompt, status chips, what this link can do. One statement (PT-19). */
export async function forumMeta(share: ShareContext): Promise<PublicForum> {
  const { rows } = await sql<{ name: string; prompt: string | null; default_label: string; labels: string[] }>`
    SELECT f.name, f.submission_prompt AS prompt, ${DEFAULT_LABEL} AS default_label,
      ARRAY(SELECT x.label FROM (
        SELECT DISTINCT ON (c.public_label) c.public_label AS label, c.sort_order
        FROM fh_post p ${POST_STATUS} JOIN fh_status_config c ON c.is_public AND c.public_label = st.label
        WHERE p.forum_id = f.id AND st.label IS NOT NULL
        ORDER BY c.public_label, c.sort_order) x ORDER BY x.sort_order, x.label) AS labels
    FROM fh_forum f WHERE f.id = ${share.targetId}::uuid`.execute(getDb());
  const r = rows[0];
  if (!r) throw new ApiError('not_found', 'Not found.');
  return {
    forum: { name: r.name, prompt: r.prompt },
    statusChips: [r.default_label, ...r.labels.filter((l) => l !== r.default_label)],
    can: { submit: share.capabilities.includes('SUBMIT'), vote: share.capabilities.includes('VOTE') },
    limits: {
      titleMax: POST_TITLE_MAX, detailsMax: POST_DETAILS_MAX, emailMax: POST_EMAIL_MAX, displayNameMax: POST_NAME_MAX,
      images: POST_IMAGES_MAX, imageBytes: POST_IMAGE_BYTES, pageSize: FORUM_PAGE,
    },
  };
}

export interface PostListQuery { sort: ForumSort; labels: string[]; q: string | null; offset: number; now: number }

/** GET forum/posts (FH-1204 to FH-1207). One statement; `cursor` is the offset of the next page. */
export async function listPublicPosts(share: ShareContext, query: PostListQuery) {
  const now = new Date(query.now).toISOString();
  const order = {
    trending: sql`(vote_count + 1) / power(GREATEST(extract(epoch FROM (${now}::timestamptz - created_at)), 0) / 3600 + 2, 1.5) DESC, id`,
    top: sql`vote_count DESC, created_at DESC, id`,
    new: sql`created_at DESC, id`,
    complete: sql`created_at DESC, id`,
  }[query.sort];
  const conds: Frag[] = [];
  if (query.sort === 'complete') conds.push(sql`st.kind = 'complete'`);
  if (query.q) {
    const like = `%${likeEscape(query.q.toLowerCase())}%`;
    conds.push(sql`(lower(p.title) LIKE ${like} OR lower(COALESCE(p.details, '')) LIKE ${like})`);
  }
  const where = conds.length ? sql.join(conds, sql` AND `) : undefined;
  const rows = await publicPosts(getDb(), share.targetId, share.visitorCookieHash, {
    where, order, limit: FORUM_PAGE + 1, offset: query.offset, labels: query.labels,
  });
  const more = rows.length > FORUM_PAGE;
  return { posts: rows.slice(0, FORUM_PAGE), nextCursor: more ? String(query.offset + FORUM_PAGE) : null };
}

/** GET forum/roadmap (FH-1208, D-36): public summary only, never the internal description. One statement. */
export async function publicRoadmap(share: ShareContext) {
  void share; // the roadmap is workspace-wide; the link only has to be valid (resolved by the pipeline)
  const { rows } = await sql<{ items: PublicRoadmapItem[] | null; anchor: string | null; length: number | null }>`
    SELECT
      (SELECT json_agg(x ORDER BY x."startDate", x.id) FROM (
        SELECT i.id::text AS id, i.title, i.public_summary AS summary, c.public_label AS "statusLabel",
               i.start_date::text AS "startDate", i.due_date::text AS "dueDate",
               (SELECT count(DISTINCT COALESCE('p' || v.person_id::text, 'u' || v.user_id::text))::int
                  FROM fh_idea_post ip JOIN fh_vote v ON v.post_id = ip.post_id WHERE ip.idea_id = i.id) AS "voterCount"
        FROM fh_idea i JOIN fh_status_config c
          ON c.status_key = CASE WHEN i.status IS NOT NULL THEN 'IDEA_' || i.status ELSE 'BUG_' || i.bug_status END
         AND c.is_public AND c.public_label IS NOT NULL
        WHERE i.merged_into_id IS NULL AND i.start_date IS NOT NULL
          AND (i.status IN ('PLANNED','IN_PROGRESS','COMPLETE') OR i.bug_status IN ('IN_DEV','FIXED','RELEASED'))
        ORDER BY i.start_date, i.id LIMIT 100) x) AS items,
      (SELECT value #>> '{}' FROM core_setting WHERE key = 'release_train.anchor') AS anchor,
      (SELECT (value #>> '{}')::int FROM core_setting WHERE key = 'release_train.length_days') AS length`.execute(getDb());
  const r = rows[0];
  const items = (r.items ?? []).map((i) => ({ ...i, voterCount: Number(i.voterCount) }));
  return { batches: releaseBatches(items, r.anchor ?? '2026-01-05', r.length ?? 21) };
}

/** GET forum/similar?title= (FH-1211): up to 4 similar posts by trigram similarity, most votes first. */
export async function similarPosts(share: ShareContext, title: string) {
  const t = (sanitise(title) ?? '').toLowerCase().slice(0, POST_TITLE_MAX);
  if (t.length < 3) return { posts: [] as PublicPost[] };
  const posts = await publicPosts(getDb(), share.targetId, share.visitorCookieHash, {
    where: sql`lower(p.title) % ${t}`, order: sql`vote_count DESC, created_at DESC, id`, limit: 4,
  });
  return { posts };
}

/** GET posts/:postId/images (FH-1209): signed URLs only for a post of this forum (SEC-10); null when it is not. */
export async function postImages(share: ShareContext, postId: string) {
  const { rows } = await sql<{ id: string | null }>`
    SELECT f.id::text FROM fh_post p
    LEFT JOIN core_file f ON f.owner_id = p.id::text AND f.module = 'fh' AND f.owner_kind = 'post' AND f.deleted_at IS NULL
    WHERE p.id = ${postId}::uuid AND p.forum_id = ${share.targetId}::uuid
    ORDER BY f.created_at, f.id LIMIT ${POST_IMAGES_MAX}`.execute(getDb());
  if (!rows.length) return null;
  const ids = rows.map((r) => r.id).filter((x): x is string => !!x);
  if (!ids.length) return { images: [] as { id: string; url: string }[] };
  const urls = await signFileUrls(ids);
  return { images: ids.filter((id) => urls[id]).map((id) => ({ id, url: urls[id].url })) };
}

// ── visitor identity (FH-1213, SEC-11) ───────────────────────────────────────────────────────────────────────
interface Author { personId: string; companyId: string | null; setCookie: string | null }

/**
 * Who a post is attributed to. Creates the visitor identity (cookie) on the first write. With an email: another
 * identity that owns it gets the post (never merged); a visitor who already has a different email gets a new
 * identity for this email (no cookie); otherwise the visitor takes the email and a company that claims its domain.
 * Emails given on the forum are not verified. ≤ 2 statements.
 */
async function resolveAuthor(tx: Db, share: ShareContext, email: string | null, displayName: string | null): Promise<Author> {
  const domain = email ? email.slice(email.lastIndexOf('@') + 1) : null;
  const { rows: [r] } = await sql<{ visitor_email: string | null; visitor_exists: boolean; owner: string | null; owner_company: string | null; company: string | null }>`
    SELECT
      EXISTS (SELECT 1 FROM core_person WHERE id = ${share.visitorPersonId}::uuid) AS visitor_exists,
      (SELECT email FROM core_person WHERE id = ${share.visitorPersonId}::uuid) AS visitor_email,
      (SELECT id::text FROM core_person WHERE email = ${email}::text) AS owner,
      (SELECT company_id::text FROM core_person WHERE email = ${email}::text) AS owner_company,
      (SELECT c.id::text FROM core_company c WHERE c.domain = ${domain}::text
         AND NOT EXISTS (SELECT 1 FROM core_setting s, jsonb_array_elements_text(s.value) d
                         WHERE s.key IN ('intake.public_email_domains', 'intake.staff_domains') AND d = ${domain}::text)) AS company`.execute(tx);
  const visitor = r.visitor_exists ? share.visitorPersonId : null;
  const name = displayName;

  if (!visitor) {
    const cookie = newVisitorCookie();
    const takesEmail = !!email && !r.owner;
    const id = newId();
    await sql`INSERT INTO core_person (id, email, display_name, cookie_token_hash, company_id, company_source)
      VALUES (${id}, ${takesEmail ? email : null}, ${name}, ${cookie.hash}, ${takesEmail ? r.company : null},
              ${takesEmail && r.company ? 'DOMAIN' : null})`.execute(tx);
    if (email && r.owner) return { personId: r.owner, companyId: r.owner_company, setCookie: cookie.header };
    return { personId: id, companyId: takesEmail ? r.company : null, setCookie: cookie.header };
  }
  if (!email) {
    const { rows: [v] } = await sql<{ company_id: string | null }>`
      UPDATE core_person SET display_name = COALESCE(${name}, display_name), last_seen_at = now()
      WHERE id = ${visitor}::uuid RETURNING company_id::text`.execute(tx);
    return { personId: visitor, companyId: v?.company_id ?? null, setCookie: null };
  }
  if (r.owner && r.owner !== visitor) return { personId: r.owner, companyId: r.owner_company, setCookie: null };
  if (r.visitor_email && r.visitor_email !== email) {
    // A second email from this browser: a new identity, never renaming the first.
    const { rows: [n] } = await sql<{ id: string; company_id: string | null }>`
      INSERT INTO core_person (id, email, display_name, company_id, company_source)
      VALUES (${newId()}, ${email}, ${name}, ${r.company}, ${r.company ? 'DOMAIN' : null})
      ON CONFLICT (email) DO UPDATE SET last_seen_at = now() RETURNING id::text, company_id::text`.execute(tx);
    return { personId: n.id, companyId: n.company_id, setCookie: null };
  }
  const { rows: [v] } = await sql<{ company_id: string | null }>`
    UPDATE core_person SET email = ${email}, display_name = COALESCE(${name}, display_name), last_seen_at = now(),
      company_id = COALESCE(company_id, ${r.company}::uuid),
      company_source = CASE WHEN company_id IS NULL AND ${r.company}::uuid IS NOT NULL THEN 'DOMAIN' ELSE company_source END
    WHERE id = ${visitor}::uuid RETURNING company_id::text`.execute(tx);
  return { personId: visitor, companyId: v?.company_id ?? null, setCookie: null };
}

/** Votes need an identity; one is created (with a cookie) on the first vote. ≤ 1 statement. */
async function ensureVisitor(tx: Db, share: ShareContext): Promise<{ personId: string; setCookie: string | null }> {
  if (share.visitorPersonId) return { personId: share.visitorPersonId, setCookie: null };
  const cookie = newVisitorCookie();
  const id = newId();
  await sql`INSERT INTO core_person (id, cookie_token_hash) VALUES (${id}, ${cookie.hash})`.execute(tx);
  return { personId: id, setCookie: cookie.header };
}

// ── submit (FH-1211, FH-1212) ────────────────────────────────────────────────────────────────────────────────
export interface PostInput { title: string; details: string | null; email: string | null; displayName: string | null }

const tooLong = (field: string, max: number) =>
  new ApiError('validation', `Must be at most ${max.toLocaleString('en-GB')} characters.`, { field });

/** Sanitises and checks post text exactly like every other post write (SEC-13: rejected, never truncated). */
export function cleanPostText(raw: { title?: unknown; details?: unknown }): { title: string; details: string | null } {
  const title = sanitise(typeof raw.title === 'string' ? raw.title : '');
  if (!title) throw new ApiError('validation', 'A title is required.', { field: 'title' });
  if (title.length > POST_TITLE_MAX) throw tooLong('title', POST_TITLE_MAX);
  const details = sanitise(typeof raw.details === 'string' ? raw.details : null);
  if (details && details.length > POST_DETAILS_MAX) throw tooLong('details', POST_DETAILS_MAX);
  return { title, details };
}

export function cleanPostInput(raw: Record<string, unknown>): PostInput {
  const { title, details } = cleanPostText(raw);
  let email: string | null = null;
  if (typeof raw.email === 'string' && raw.email.trim()) {
    email = normaliseEmail(raw.email);
    if (email.length > POST_EMAIL_MAX) throw tooLong('email', POST_EMAIL_MAX);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError('validation', 'Enter an email address like name@example.com.', { field: 'email' });
  }
  const displayName = sanitise(typeof raw.displayName === 'string' ? raw.displayName : null);
  if (displayName && displayName.length > POST_NAME_MAX) throw tooLong('displayName', POST_NAME_MAX);
  return { title, details, email, displayName };
}

/** Screenshots are stored before the rows, with the post's pre-generated id (ING-25 pattern). */
export async function preparePostImages(postId: string, files: { bytes: Buffer; name: string | null }[]): Promise<PreparedFile[]> {
  if (files.length > POST_IMAGES_MAX) throw new ApiError('validation', `Attach at most ${POST_IMAGES_MAX} screenshots.`, { field: 'images' });
  const out: PreparedFile[] = [];
  try {
    for (const f of files) {
      if (f.bytes.length > POST_IMAGE_BYTES) throw new ApiError('too_large', 'Each screenshot must be 2 MB or smaller.', { field: 'images' });
      out.push(await prepareUpload({
        module: 'fh', ownerKind: 'post', ownerId: postId, bytes: f.bytes, originalName: f.name, createdBy: null, maxBytes: POST_IMAGE_BYTES,
      }));
    }
  } catch (e) {
    await discardUploads(out);
    throw e;
  }
  return out;
}

/**
 * POST posts: one transaction creates the post (vote count 1), the author's vote and vote event, an idea (Feature
 * request, Open, born reviewed, unowned) with its history, the idea-post link, a Forum insight, the people and
 * company links and the roll-up (FH-1212). Forum submissions never become bugs (OD-21). ≤ 9 statements.
 */
export async function submitPost(share: ShareContext, input: PostInput, postId: string, files: PreparedFile[]) {
  const ideaId = newId(), insightId = newId();
  let author: Author;
  try {
    author = await getDb().transaction().execute(async (tx) => {
      const a = await resolveAuthor(tx, share, input.email, input.displayName);
      const { rows: [f] } = await sql<{ name: string }>`
        WITH post AS (
          INSERT INTO fh_post (id, forum_id, title, details, author_person_id, vote_count, image_count)
          VALUES (${postId}, ${share.targetId}::uuid, ${input.title}, ${input.details}, ${a.personId}::uuid, 1, ${files.length})
          RETURNING id),
        vote AS (INSERT INTO fh_vote (id, post_id, person_id) SELECT ${newId()}::uuid, id, ${a.personId}::uuid FROM post),
        ev AS (INSERT INTO fh_vote_event (id, post_id, action, person_id) SELECT ${newId()}::uuid, id, 'UP', ${a.personId}::uuid FROM post)
        SELECT name FROM fh_forum WHERE id = ${share.targetId}::uuid`.execute(tx);
      await sql`
        WITH idea AS (
          INSERT INTO fh_idea (id, title, description, idea_type, status, owner_id, created_by)
          VALUES (${ideaId}, ${input.title}, ${input.details}, 'FEATURE_REQUEST', 'OPEN', NULL, NULL) RETURNING id),
        hist AS (INSERT INTO fh_status_change (id, idea_id, from_status, to_status, actor_id)
                 SELECT ${newId()}::uuid, id, NULL, 'IDEA_OPEN', NULL FROM idea),
        act AS (INSERT INTO fh_idea_event (id, idea_id, actor_id, actor_label, field, from_value, to_value)
                SELECT ${newId()}::uuid, id, NULL, 'Forum', 'created', NULL, ${`Created from the forum: ${f.name}`} FROM idea)
        INSERT INTO fh_idea_post (idea_id, post_id) SELECT id, ${postId}::uuid FROM idea`.execute(tx);
      // INV-13: the insight names the author and their company, so both "who asked" rows exist.
      await sql`
        WITH ins AS (
          INSERT INTO fh_insight (id, idea_id, value, source, source_ref, person_id, company_id)
          VALUES (${insightId}, ${ideaId}, ${input.details ?? input.title}, 'FORUM', ${postId}, ${a.personId}::uuid, ${a.companyId}::uuid)),
        pl AS (INSERT INTO fh_idea_person (idea_id, person_id) VALUES (${ideaId}, ${a.personId}::uuid) ON CONFLICT DO NOTHING)
        INSERT INTO fh_idea_company (idea_id, company_id)
        SELECT ${ideaId}::uuid, ${a.companyId}::uuid WHERE ${a.companyId}::uuid IS NOT NULL ON CONFLICT DO NOTHING`.execute(tx);
      await insertFileRows(tx, files);
      await sql`SELECT fh_rollup_refresh(ARRAY[${ideaId}::uuid])`.execute(tx);
      await enqueue('fh.match.compute', { ideaId }, { dedupeKey: `fh.match:${ideaId}` }, tx);
      return a;
    });
  } catch (e) {
    await discardUploads(files);
    throw e;
  }
  drainSoon();
  // Read back through the public read path, so a new post shows exactly what the list shows. A cookie issued by
  // this request is matched by its hash.
  const hash = author.setCookie ? sha256(author.setCookie.split(';')[0].split('=')[1] ?? '') : share.visitorCookieHash;
  const post = await readPublicPost(share, postId, hash);
  if (!post) throw new Error('post vanished after commit');
  return { post, setCookie: author.setCookie };
}

/** One post of this forum in the public shape. One statement. */
async function readPublicPost(share: ShareContext, postId: string, cookieHash: string | null) {
  const rows = await publicPosts(getDb(), share.targetId, cookieHash, { where: sql`p.id = ${postId}::uuid`, order: sql`id`, limit: 1 });
  return rows[0] ?? null;
}

/** PATCH posts/:postId (FH-1214): own post in this forum only, else the share 404. ≤ 2 statements. */
export async function editOwnPost(share: ShareContext, postId: string, text: { title: string; details: string | null }) {
  if (!share.visitorPersonId) return null;
  const res = await sql`UPDATE fh_post SET title = ${text.title}, details = ${text.details}, updated_at = now()
    WHERE id = ${postId}::uuid AND forum_id = ${share.targetId}::uuid AND author_person_id = ${share.visitorPersonId}::uuid`.execute(getDb());
  if (!Number(res.numAffectedRows ?? 0)) return null;
  return readPublicPost(share, postId, share.visitorCookieHash);
}

// ── votes (FH-1251, FH-1252) ─────────────────────────────────────────────────────────────────────────────────
/**
 * Upvote: the post must belong to this link's forum (by id and forum id); duplicates are skipped; an inserted vote
 * increments the count, writes an UP event and refreshes the linked ideas' roll-ups. ≤ 3 statements.
 */
export async function vote(share: ShareContext, postId: string): Promise<{ result: VoteResult; setCookie: string | null } | null> {
  return getDb().transaction().execute(async (tx) => {
    const who = await ensureVisitor(tx, share);
    const { rows: [r] } = await sql<{ found: boolean; changed: boolean; vote_count: number | null }>`
      WITH p AS (SELECT id, vote_count FROM fh_post WHERE id = ${postId}::uuid AND forum_id = ${share.targetId}::uuid),
      ins AS (INSERT INTO fh_vote (id, post_id, person_id) SELECT ${newId()}::uuid, id, ${who.personId}::uuid FROM p
              ON CONFLICT DO NOTHING RETURNING post_id),
      upd AS (UPDATE fh_post SET vote_count = vote_count + 1 WHERE id IN (SELECT post_id FROM ins) RETURNING vote_count),
      ev AS (INSERT INTO fh_vote_event (id, post_id, action, person_id) SELECT ${newId()}::uuid, post_id, 'UP', ${who.personId}::uuid FROM ins)
      SELECT EXISTS (SELECT 1 FROM p) AS found, EXISTS (SELECT 1 FROM ins) AS changed,
             COALESCE((SELECT vote_count FROM upd), (SELECT vote_count FROM p)) AS vote_count`.execute(tx);
    if (!r.found) throw new NotInForum();
    if (r.changed) await refreshPostIdeas(tx, postId);
    return { result: { postId, hasVoted: true, voteCount: Number(r.vote_count), changed: r.changed }, setCookie: who.setCookie };
  }).catch((e) => { if (e instanceof NotInForum) return null; throw e; });
}

/** Remove a vote. With no visitor identity it is a no-op that creates none. ≤ 3 statements. */
export async function unvote(share: ShareContext, postId: string): Promise<VoteResult | null> {
  return getDb().transaction().execute(async (tx) => {
    const { rows: [r] } = await sql<{ found: boolean; changed: boolean; vote_count: number | null }>`
      WITH p AS (SELECT id, vote_count FROM fh_post WHERE id = ${postId}::uuid AND forum_id = ${share.targetId}::uuid),
      del AS (DELETE FROM fh_vote WHERE post_id IN (SELECT id FROM p) AND person_id = ${share.visitorPersonId}::uuid RETURNING post_id),
      upd AS (UPDATE fh_post SET vote_count = GREATEST(vote_count - 1, 0) WHERE id IN (SELECT post_id FROM del) RETURNING vote_count),
      ev AS (INSERT INTO fh_vote_event (id, post_id, action, person_id) SELECT ${newId()}::uuid, post_id, 'UNDO', ${share.visitorPersonId}::uuid FROM del)
      SELECT EXISTS (SELECT 1 FROM p) AS found, EXISTS (SELECT 1 FROM del) AS changed,
             COALESCE((SELECT vote_count FROM upd), (SELECT vote_count FROM p)) AS vote_count`.execute(tx);
    if (!r.found) throw new NotInForum();
    if (r.changed) await refreshPostIdeas(tx, postId);
    return { postId, hasVoted: false, voteCount: Number(r.vote_count), changed: r.changed };
  }).catch((e) => { if (e instanceof NotInForum) return null; throw e; });
}

class NotInForum extends Error {}

/** Roll-ups of every live idea linked to a post (FH-504). One statement. */
export async function refreshPostIdeas(tx: Db, postId: string) {
  await sql`SELECT fh_rollup_refresh(ARRAY(SELECT idea_id FROM fh_idea_post WHERE post_id = ${postId}::uuid))`.execute(tx);
}

// ── route helpers ────────────────────────────────────────────────────────────────────────────────────────────
/** SEC-27: forum submit and edit, 30 per hour per IP and 20 per hour per visitor identity. */
export const SUBMIT_LIMITS = { key: 'fh-submit', perIp: [30, 3600] as [number, number], perIdentity: [20, 3600] as [number, number] };
/** SEC-27: votes, 120 per hour per IP and 120 per hour per visitor identity. */
export const VOTE_LIMITS = { key: 'fh-vote', perIp: [120, 3600] as [number, number], perIdentity: [120, 3600] as [number, number] };

/** JSON answer that also stores a newly issued visitor cookie (SEC-11). */
export function jsonWithCookie(body: unknown, setCookie: string | null, status = 200): Response {
  const res = Response.json(body, { status });
  if (setCookie) res.headers.append('Set-Cookie', setCookie);
  return res;
}
