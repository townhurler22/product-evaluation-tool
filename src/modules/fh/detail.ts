// Idea panel reads (§4.6): a small summary plus lazy sections, each ≤ 3 statements (PERF-12, D-03).
import { sql } from 'kysely';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { newId, signFileUrls, type Principal } from '@/modules/core/service';
import { readIntakeMeta } from './intake-meta';
import { publishDetail } from './live';
import { lockIdeas } from './store';

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

/** GET ideas/:id. One statement; 410 with mergedIntoId for a tombstone (FH-223). */
export async function ideaSummary(id: string) {
  const { rows } = await sql<{
    id: string; number: number; title: string; description: string | null; public_summary: string | null;
    merged_into_id: string | null; merged_number: number | null; merged_title: string | null;
    themes: { id: string; name: string; colour: string | null }[];
    journeys: { id: string; name: string }[];
    companies: { id: string; name: string; arr: string | null }[];
    people: { id: string; name: string; companyName: string | null }[];
    posts: { id: string; title: string; voteCount: number }[];
    created_by_name: string | null;
  }>`
    SELECT i.id, i.number::int AS number, i.title, i.description, i.public_summary, i.merged_into_id,
      t.number::int AS merged_number, t.title AS merged_title,
      COALESCE((SELECT json_agg(json_build_object('id', th.id, 'name', th.name, 'colour', th.colour) ORDER BY th.name_key)
        FROM fh_idea_theme it JOIN fh_theme th ON th.id = it.theme_id WHERE it.idea_id = i.id), '[]') AS themes,
      COALESCE((SELECT json_agg(json_build_object('id', j.id, 'name', j.name) ORDER BY j.name_key)
        FROM fh_idea_journey ij JOIN fh_journey j ON j.id = ij.journey_id WHERE ij.idea_id = i.id), '[]') AS journeys,
      COALESCE((SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'arr', c.arr::text) ORDER BY c.name_key)
        FROM fh_idea_company ic JOIN core_company c ON c.id = ic.company_id WHERE ic.idea_id = i.id), '[]') AS companies,
      COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', COALESCE(p.display_name, 'Anonymous'), 'companyName', pc.name)
          ORDER BY COALESCE(p.display_name, 'Anonymous'))
        FROM fh_idea_person ip JOIN core_person p ON p.id = ip.person_id LEFT JOIN core_company pc ON pc.id = p.company_id
        WHERE ip.idea_id = i.id), '[]') AS people,
      COALESCE((SELECT json_agg(json_build_object('id', po.id, 'title', po.title, 'voteCount', po.vote_count))
        FROM fh_idea_post ipo JOIN fh_post po ON po.id = ipo.post_id WHERE ipo.idea_id = i.id), '[]') AS posts,
      (SELECT COALESCE(u.full_name, u.email) FROM core_user u WHERE u.id = i.created_by) AS created_by_name
    FROM fh_idea i LEFT JOIN fh_idea t ON t.id = i.merged_into_id
    WHERE i.id = ${id}::uuid`.execute(getDb());
  const r = rows[0];
  if (!r) throw new ApiError('not_found', 'Not found.');
  if (r.merged_into_id) {
    throw new ApiError('gone', `This idea was merged into #${r.merged_number} ${r.merged_title}`, {
      mergedIntoId: r.merged_into_id, mergedInto: { number: r.merged_number, title: r.merged_title },
    });
  }
  return {
    summary: {
      id: r.id, number: r.number, title: r.title, description: r.description, publicSummary: r.public_summary,
      themes: r.themes, journeys: r.journeys, companies: r.companies, people: r.people, posts: r.posts,
      createdByName: r.created_by_name,
    },
  };
}

/** GET ideas/:id/evidence: insights with person and company, and the counted people (FH-217). Two statements. */
export async function ideaEvidence(id: string) {
  const db = getDb();
  const insights = await sql<Record<string, unknown>>`
    SELECT ins.id, ins.value, ins.source, ins.priority, ins.url, ins.created_at AS "createdAt", ins.meta,
      ins.company_id AS "companyId", c.name AS "companyName",
      ins.person_id AS "personId", COALESCE(p.display_name, CASE WHEN p.id IS NOT NULL THEN 'Anonymous' END) AS "personName",
      p.verified_by AS "verifiedBy", COALESCE(su.full_name, su.email) AS "staffName"
    FROM fh_insight ins
    LEFT JOIN core_company c ON c.id = ins.company_id
    LEFT JOIN core_person p ON p.id = ins.person_id
    LEFT JOIN core_user su ON su.id = ins.staff_user_id
    WHERE ins.idea_id = ${id}::uuid ORDER BY ins.created_at DESC, ins.id DESC`.execute(db);
  // Every person behind the Users number, tagged with why (linked / insight / vote).
  const counted = await sql<{ id: string; name: string; companyName: string | null; reasons: string[] }>`
    WITH ev AS (
      SELECT person_id, 'insight' AS why FROM fh_insight WHERE idea_id = ${id}::uuid AND person_id IS NOT NULL
      UNION ALL SELECT person_id, 'linked' FROM fh_idea_person WHERE idea_id = ${id}::uuid
      UNION ALL SELECT v.person_id, 'vote' FROM fh_idea_post ip JOIN fh_vote v ON v.post_id = ip.post_id
        WHERE ip.idea_id = ${id}::uuid AND v.person_id IS NOT NULL)
    SELECT p.id, COALESCE(p.display_name, 'Anonymous') AS name, c.name AS "companyName",
      array_agg(DISTINCT ev.why ORDER BY ev.why) AS reasons
    FROM ev JOIN core_person p ON p.id = ev.person_id LEFT JOIN core_company c ON c.id = p.company_id
    GROUP BY p.id, p.display_name, c.name ORDER BY name LIMIT 500`.execute(db);
  return {
    insights: insights.rows.map((r) => ({ ...r, createdAt: iso(r.createdAt), meta: readIntakeMeta(r.meta) })),
    countedPeople: counted.rows,
  };
}

/**
 * GET ideas/:id/images (FH-218): screenshots owned by the idea's insights, as 15-minute signed URLs created at read
 * time (ING-27). Forum post images join in P3. One statement plus signing.
 */
export async function ideaImages(id: string) {
  const { rows } = await sql<{ id: string; insight_id: string; name: string | null; size: number }>`
    SELECT f.id::text, f.owner_id AS insight_id, f.original_name AS name, f.size_bytes AS size
    FROM core_file f JOIN fh_insight i ON f.owner_id = i.id::text
    WHERE f.module = 'fh' AND f.owner_kind = 'insight' AND f.deleted_at IS NULL AND i.idea_id = ${id}::uuid
    ORDER BY f.created_at, f.id LIMIT 60`.execute(getDb());
  const urls = await signFileUrls(rows.map((r) => r.id));
  return {
    images: rows.filter((r) => urls[r.id]).map((r) => ({
      id: r.id, insightId: r.insight_id, name: r.name, size: r.size, url: urls[r.id].url, contentType: urls[r.id].contentType,
    })),
  };
}

/** GET ideas/:id/activity: status changes and field events interleaved, newest 50 (FH-220). One statement. */
export async function ideaActivity(id: string, before: string | null) {
  const { rows } = await sql<Record<string, unknown>>`
    SELECT * FROM (
      SELECT sc.id, 'status' AS kind, NULL AS field, sc.from_status AS "from", sc.to_status AS "to", sc.comment,
        sc.changed_at AS at, COALESCE(u.full_name, u.email) AS actor, NULL AS "actorLabel"
      FROM fh_status_change sc LEFT JOIN core_user u ON u.id = sc.actor_id WHERE sc.idea_id = ${id}::uuid
      UNION ALL
      SELECT e.id, 'field', e.field, e.from_value, e.to_value, NULL, e.created_at, COALESCE(u.full_name, u.email), e.actor_label
      FROM fh_idea_event e LEFT JOIN core_user u ON u.id = e.actor_id WHERE e.idea_id = ${id}::uuid
    ) a
    WHERE ${before ? sql`a.at < ${before}::timestamptz` : sql`true`}
    ORDER BY a.at DESC, a.id DESC LIMIT 51`.execute(getDb());
  const items = rows.slice(0, 50).map((r) => ({ ...r, at: iso(r.at) }));
  return { items, nextBefore: rows.length > 50 ? items[items.length - 1].at : null };
}

/** GET ideas/:id/matches: stored suggestions, merged or deleted candidates dropped at read time. One statement. */
export async function ideaMatches(id: string) {
  const { rows } = await sql<{ id: string; number: number; title: string; score: number; status: string | null; bugStatus: string | null }>`
    SELECT c.id, c.number::int AS number, c.title, round(m.score::numeric, 2)::float8 AS score, c.status, c.bug_status AS "bugStatus"
    FROM fh_idea_match m JOIN fh_idea c ON c.id = m.candidate_id AND c.merged_into_id IS NULL
    WHERE m.idea_id = ${id}::uuid ORDER BY m.score DESC, m.title_hits DESC, c.updated_at DESC LIMIT 5`.execute(getDb());
  return { matches: rows };
}

// ── comments (FH-219): admin read and write, authors edit and delete their own ──
export async function listComments(id: string) {
  const { rows } = await sql<Record<string, unknown>>`
    SELECT c.id, c.body, c.author_id AS "authorId", COALESCE(u.full_name, u.email) AS "authorName",
      c.created_at AS "createdAt", c.edited_at AS "editedAt", c.deleted_at IS NOT NULL AS deleted
    FROM fh_comment c LEFT JOIN core_user u ON u.id = c.author_id
    WHERE c.idea_id = ${id}::uuid ORDER BY c.created_at, c.id LIMIT 500`.execute(getDb());
  return { comments: rows.map((r) => ({ ...r, createdAt: iso(r.createdAt), editedAt: iso(r.editedAt) })) };
}

export async function addComment(p: Principal, ideaId: string, body: string) {
  const id = newId();
  await getDb().transaction().execute(async (tx) => {
    const cur = (await lockIdeas(tx, [ideaId])).get(ideaId);
    if (!cur) throw new ApiError('not_found', 'Not found.');
    if (cur.mergedIntoId) throw new ApiError('conflict', 'This idea has been merged into another.');
    await tx.insertInto('fh_comment').values({ id, idea_id: ideaId, author_id: p.userId, body }).execute();
  });
  publishIdeasDetail(ideaId);
  return { comment: { id, body, authorId: p.userId, createdAt: new Date().toISOString(), editedAt: null, deleted: false } };
}

export async function editComment(p: Principal, id: string, body: string | null) {
  const db = getDb();
  const c = await db.selectFrom('fh_comment').select(['author_id', 'idea_id', 'deleted_at']).where('id', '=', id).executeTakeFirst();
  if (!c) throw new ApiError('not_found', 'Not found.');
  if (c.author_id !== p.userId) throw new ApiError('forbidden', 'Only the author can change a comment.');
  if (c.deleted_at) throw new ApiError('conflict', 'This comment was deleted.');
  await db.updateTable('fh_comment')
    .set(body === null ? { body: null, deleted_at: new Date() } : { body, edited_at: new Date() })
    .where('id', '=', id).execute();
  publishIdeasDetail(c.idea_id);
  return { comment: { id, body, deleted: body === null } };
}

function publishIdeasDetail(ideaId: string) {
  // Comments change no list field, so only the panel's comments section is refreshed.
  publishDetail(ideaId, ['comments']);
}
