// Publishing ideas to the main forum (FH-411 to FH-413). Preview returns editable text; publish re-checks each idea
// inside its own transaction and opens the post with exactly one vote.
import { sql } from 'kysely';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { audit, newId, type Principal } from '@/modules/core/service';
import { POST_DETAILS_MAX, POST_TITLE_MAX } from './forum-domain';
import { publishIdeas } from './live';
import { rowsByIds } from './rows';

interface MainForum { id: string; name: string }

async function mainForum(): Promise<MainForum> {
  const { rows } = await sql<MainForum>`SELECT id::text, name FROM fh_forum WHERE is_main`.execute(getDb());
  if (!rows[0]) throw new ApiError('conflict', 'No forum is set as the main forum.');
  return rows[0];
}

/** FH-411 refusals, in the order they are checked. */
function refusal(i: { found: boolean; merged: boolean; idea_type: string | null; on_forum: boolean }): string | null {
  if (!i.found) return 'Not found.';
  if (i.merged) return 'Merged into another idea.';
  if (i.idea_type === 'QUESTION') return 'Questions cannot be published.';
  if (i.on_forum) return 'Already on a forum.';
  return null;
}

export type PreviewItem = { ideaId: string; title: string; details: string | null } | { ideaId: string; reason: string };

/** POST ideas/publish/preview: per idea in request order, editable text (truncated) or the refusal. 2 statements. */
export async function publishPreview(ids: string[]): Promise<{ forum: MainForum; items: PreviewItem[] }> {
  const forum = await mainForum();
  const { rows } = await sql<{ id: string; title: string; description: string | null; idea_type: string; merged: boolean; on_forum: boolean }>`
    SELECT i.id::text, i.title, i.description, i.idea_type, i.merged_into_id IS NOT NULL AS merged,
           EXISTS (SELECT 1 FROM fh_idea_post ip WHERE ip.idea_id = i.id) AS on_forum
    FROM fh_idea i WHERE i.id = ANY(${ids}::uuid[])`.execute(getDb());
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    forum,
    items: ids.map((id) => {
      const r = byId.get(id);
      const reason = refusal({ found: !!r, merged: !!r?.merged, idea_type: r?.idea_type ?? null, on_forum: !!r?.on_forum });
      if (reason || !r) return { ideaId: id, reason: reason ?? 'Not found.' };
      return { ideaId: id, title: r.title.slice(0, POST_TITLE_MAX), details: r.description ? r.description.slice(0, POST_DETAILS_MAX) : null };
    }),
  };
}

export interface PublishItem { ideaId: string; title: string; details: string | null }

/**
 * POST ideas/publish (FH-412, FH-413). The previewed forum id is a staleness check. Each idea runs in its own
 * transaction: lock and re-check (1), then the post, link, the one opening vote, its event, the activity row and the
 * version bump (1), then the roll-up (1). Statements: 2 + 3 per idea + audit + the changed rows.
 */
export async function publishIdeasToForum(p: Principal, forumId: string, items: PublishItem[]) {
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.ideaId)) throw new ApiError('validation', 'Each idea can be published once per request.', { field: 'items' });
    seen.add(it.ideaId);
  }
  const forum = await mainForum();
  if (forum.id !== forumId) throw new ApiError('conflict', `The main forum is now ${forum.name}`, { forum });

  const published: { ideaId: string; postId: string }[] = [];
  const skipped: { ideaId: string; reason: string }[] = [];
  for (const it of items) {
    const postId = newId();
    const reason = await getDb().transaction().execute(async (tx) => {
      // Lock the idea, re-check the refusals, and find the opening voter: the earliest requester with an identity
      // (earliest insight with a person, else earliest person link), else the publishing staff member.
      const { rows: [r] } = await sql<{ found: boolean; merged: boolean; idea_type: string | null; on_forum: boolean; voter: string | null }>`
        WITH i AS (SELECT id, idea_type, merged_into_id FROM fh_idea WHERE id = ${it.ideaId}::uuid FOR UPDATE)
        SELECT EXISTS (SELECT 1 FROM i) AS found, (SELECT merged_into_id IS NOT NULL FROM i) AS merged,
               (SELECT idea_type FROM i) AS idea_type,
               EXISTS (SELECT 1 FROM fh_idea_post ip WHERE ip.idea_id = ${it.ideaId}::uuid) AS on_forum,
               COALESCE(
                 (SELECT s.person_id::text FROM fh_insight s WHERE s.idea_id = ${it.ideaId}::uuid AND s.person_id IS NOT NULL
                   ORDER BY s.created_at, s.id LIMIT 1),
                 (SELECT pp.person_id::text FROM fh_idea_person pp WHERE pp.idea_id = ${it.ideaId}::uuid
                   ORDER BY pp.created_at, pp.person_id LIMIT 1)) AS voter`.execute(tx);
      const why = refusal({ found: r.found, merged: !!r.merged, idea_type: r.idea_type, on_forum: r.on_forum });
      if (why) return why;
      const person = r.voter, user = r.voter ? null : p.userId;
      await sql`
        WITH post AS (
          INSERT INTO fh_post (id, forum_id, title, details, author_user_id, vote_count)
          VALUES (${postId}, ${forum.id}::uuid, ${it.title}, ${it.details}, ${p.userId}, 1) RETURNING id),
        link AS (INSERT INTO fh_idea_post (idea_id, post_id) SELECT ${it.ideaId}::uuid, id FROM post),
        v AS (INSERT INTO fh_vote (id, post_id, person_id, user_id) SELECT ${newId()}::uuid, id, ${person}::uuid, ${user}::uuid FROM post),
        ev AS (INSERT INTO fh_vote_event (id, post_id, action, person_id, user_id)
               SELECT ${newId()}::uuid, id, 'UP', ${person}::uuid, ${user}::uuid FROM post),
        act AS (INSERT INTO fh_idea_event (id, idea_id, actor_id, field, from_value, to_value)
                VALUES (${newId()}, ${it.ideaId}::uuid, ${p.userId}, 'published', NULL, ${`Published → ${forum.name}`}))
        UPDATE fh_idea SET version = version + 1, updated_at = now() WHERE id = ${it.ideaId}::uuid`.execute(tx); // INV-12
      await sql`SELECT fh_rollup_refresh(ARRAY[${it.ideaId}::uuid])`.execute(tx);
      return null;
    });
    if (reason) skipped.push({ ideaId: it.ideaId, reason });
    else published.push({ ideaId: it.ideaId, postId });
  }
  if (published.length) {
    await audit({ actorKind: 'user', actorId: p.userId, action: 'fh.idea.publish', targetKind: 'forum', targetId: forum.id,
      details: { published: published.map((x) => x.ideaId), skipped: skipped.length } });
    publishIdeas(await rowsByIds(getDb(), published.map((x) => x.ideaId)));
  }
  return { forum, published, skipped };
}
