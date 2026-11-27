// Companies, people and ARR (§7.14), and Feedback Hub's part of erasure (SEC-20, `feedbackHub.erasePerson`).
// Roll-ups follow FH-505: recomputed in the same transaction for ≤ 500 affected ideas, otherwise by a job.
import { sql, type RawBuilder } from 'kysely';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import {
  audit, emailDomain, enqueue, newId, normaliseDomain, normaliseEmail, type ErasureOutcome, type Principal,
} from '@/modules/core/service';
import { drainSoon, publishIdeas } from './live';
import { rowsByIds } from './rows';
import { refreshRollups, translateDbError, type Db } from './store';

export const PAGE = 50;
export const ROLLUP_INLINE_MAX = 500; // FH-505
const likeTerm = (q: string | null | undefined) => (q?.trim() ? `%${q.trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%` : null);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

/** Distinct ideas whose evidence includes any of these companies (FH-504 evidence set). */
const companyIdeaIds = (ids: RawBuilder<unknown>) => sql`
  SELECT idea_id FROM fh_idea_company WHERE company_id = ANY(${ids})
  UNION SELECT idea_id FROM fh_insight WHERE company_id = ANY(${ids})
  UNION SELECT i.idea_id FROM fh_insight i JOIN core_person p ON p.id = i.person_id WHERE i.company_id IS NULL AND p.company_id = ANY(${ids})
  UNION SELECT ip.idea_id FROM fh_idea_person ip JOIN core_person p ON p.id = ip.person_id WHERE p.company_id = ANY(${ids})
  UNION SELECT ipo.idea_id FROM fh_idea_post ipo JOIN fh_vote v ON v.post_id = ipo.post_id JOIN core_person p ON p.id = v.person_id
        WHERE p.company_id = ANY(${ids})`;

/** Distinct ideas whose evidence includes any of these people. */
const personIdeaIds = (ids: RawBuilder<unknown>) => sql`
  SELECT idea_id FROM fh_insight WHERE person_id = ANY(${ids})
  UNION SELECT idea_id FROM fh_idea_person WHERE person_id = ANY(${ids})
  UNION SELECT ipo.idea_id FROM fh_idea_post ipo JOIN fh_vote v ON v.post_id = ipo.post_id WHERE v.person_id = ANY(${ids})`;

const uuids = (ids: string[]) => sql`${ids}::uuid[]`;

/** FH-505. Returns true when the recompute was handed to a job ("Revenue figures updating"). */
async function refreshAffected(tx: Db, ideaIds: string[]): Promise<boolean> {
  if (!ideaIds.length) return false;
  if (ideaIds.length <= ROLLUP_INLINE_MAX) { await refreshRollups(tx, ideaIds); return false; }
  await enqueue('fh.rollup.refresh', { ideaIds }, {}, tx);
  return true;
}

async function afterRollups(ideaIds: string[], pending: boolean) {
  if (pending) { drainSoon(); return; }
  if (ideaIds.length && ideaIds.length <= 100) publishIdeas(await rowsByIds(getDb(), ideaIds));
}

async function inTx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  try { return await getDb().transaction().execute(fn); } catch (e) { throw translateDbError(e); }
}

/** FH-802: digits, ≤ 12 integer digits, ≤ 2 decimals, commas stripped. Money stays a string (FH-506). */
export function parseArr(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).replace(/,/g, '').trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) {
    throw new ApiError('validation', 'ARR must be a number with up to 12 digits and 2 decimals.', { field: 'arr' });
  }
  return s;
}

function domainOrError(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const d = normaliseDomain(raw);
  if (!d) throw new ApiError('validation', 'Enter a domain such as example.com.', { field: 'domain' });
  return d;
}

// ── companies ───────────────────────────────────────────────────────────────────────────────────────────
/** FH-801 (and the idea panel's picker): ARR highest first, no ARR last, then name. One statement. */
export async function listCompanies(q: string | null, offset = 0, full = false) {
  const term = likeTerm(q);
  const { rows } = await sql<Record<string, unknown> & { total: number }>`
    SELECT c.id, c.name, c.domain, c.arr::text AS arr
      ${full ? sql`, c.aliases, c.prospect_at IS NOT NULL AS prospect,
        (SELECT count(*) FROM core_person p WHERE p.company_id = c.id)::int AS "peopleCount",
        (SELECT count(*) FROM (${companyIdeaIds(sql`ARRAY[c.id]`)}) x JOIN fh_idea i ON i.id = x.idea_id AND i.merged_into_id IS NULL)::int AS "ideaCount",
        count(*) OVER ()::int AS total` : sql``}
    FROM core_company c
    WHERE ${term ? sql`(c.name_key LIKE ${term} OR c.domain LIKE ${term})` : sql`true`}
    ORDER BY c.arr DESC NULLS LAST, c.name_key, c.id LIMIT ${PAGE} OFFSET ${offset}`.execute(getDb());
  const total = full ? (rows[0]?.total ?? 0) : undefined;
  return {
    companies: rows.map(({ total: _t, ...r }) => { void _t; return r; }),
    ...(full && { total, nextOffset: offset + rows.length < (total ?? 0) ? offset + rows.length : null }),
  };
}

/** FH-805: profile, people, ideas asked for (with status) and total open demand. One statement. */
export async function companyDetail(id: string, withEmails: boolean) {
  const { rows } = await sql<Record<string, unknown>>`
    WITH ideas AS (SELECT i.id, i.number::int AS number, i.title, i.status, i.bug_status AS "bugStatus", i.updated_at,
                          fh_is_open(i.status, i.bug_status) AS open
                   FROM (${companyIdeaIds(sql`ARRAY[${id}::uuid]`)}) x JOIN fh_idea i ON i.id = x.idea_id AND i.merged_into_id IS NULL)
    SELECT c.id, c.name, c.domain, c.arr::text AS arr, c.aliases, c.prospect_at IS NOT NULL AS prospect, c.created_at AS "createdAt",
      COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', COALESCE(p.display_name, 'Anonymous'),
                 'email', CASE WHEN ${withEmails} THEN p.email END, 'source', p.company_source) ORDER BY p.last_seen_at DESC)
                FROM (SELECT * FROM core_person WHERE company_id = c.id ORDER BY last_seen_at DESC LIMIT 100) p), '[]') AS people,
      (SELECT count(*)::int FROM core_person WHERE company_id = c.id) AS "peopleCount",
      COALESCE((SELECT json_agg(json_build_object('id', d.id, 'number', d.number, 'title', d.title, 'status', d.status, 'bugStatus', d."bugStatus"))
                FROM (SELECT * FROM ideas ORDER BY open DESC, updated_at DESC LIMIT 100) d), '[]') AS ideas,
      (SELECT count(*)::int FROM ideas) AS "ideaCount",
      (SELECT count(*)::int FROM ideas WHERE open) AS "openDemand"
    FROM core_company c WHERE c.id = ${id}::uuid`.execute(getDb());
  if (!rows[0]) throw new ApiError('not_found', 'Not found.');
  return { company: { ...rows[0], createdAt: iso(rows[0].createdAt) } };
}

export interface CompanyInput { name?: string; domain?: string | null; arr?: string | number | null; aliases?: string[] }

/** FH-802. People with no company whose email ends with @<domain> are attributed to it (source DOMAIN). */
export async function createCompany(p: Principal, input: CompanyInput & { name: string }) {
  const domain = domainOrError(input.domain);
  const arr = parseArr(input.arr);
  const id = newId();
  let adopted: string[] = [];
  let pending = false, affected: string[] = [];
  await inTx(async (tx) => {
    if (domain) await assertDomainFree(tx, domain, null);
    await tx.insertInto('core_company').values({ id, name: input.name, domain, arr, aliases: input.aliases ?? [] }).execute();
    if (domain) adopted = await adopt(tx, id, domain);
    affected = adopted.length ? await ideaIdsFor(tx, null, adopted) : [];
    pending = await refreshAffected(tx, affected);
    await audit({ actorKind: 'user', actorId: p.userId, action: 'fh.company.create', targetKind: 'company', targetId: id, details: { adopted: adopted.length } }, tx);
  });
  await afterRollups(affected, pending);
  return { ...(await companyDetail(id, true)), adopted: adopted.length, rollupsPending: pending };
}

async function assertDomainFree(tx: Db, domain: string, exceptId: string | null) {
  const owner = await sql<{ name: string }>`SELECT name FROM core_company WHERE domain = ${domain} AND id IS DISTINCT FROM ${exceptId}::uuid`.execute(tx);
  if (owner.rows[0]) throw new ApiError('conflict', `This domain belongs to ${owner.rows[0].name}.`, { field: 'domain' });
}

async function adopt(tx: Db, companyId: string, domain: string): Promise<string[]> {
  const r = await sql<{ id: string }>`
    UPDATE core_person SET company_id = ${companyId}::uuid, company_source = 'DOMAIN'
    WHERE company_id IS NULL AND split_part(email, '@', 2) = ${domain} RETURNING id::text`.execute(tx);
  return r.rows.map((x) => x.id);
}

async function ideaIdsFor(tx: Db, companyIds: string[] | null, personIds: string[]): Promise<string[]> {
  const parts = [];
  if (companyIds?.length) parts.push(companyIdeaIds(uuids(companyIds)));
  if (personIds.length) parts.push(personIdeaIds(uuids(personIds)));
  if (!parts.length) return [];
  const { rows } = await sql<{ id: string }>`SELECT DISTINCT idea_id::text AS id FROM (${sql.join(parts, sql` UNION `)}) x`.execute(tx);
  return rows.map((r) => r.id);
}

/** FH-803: a domain change releases DOMAIN attributions under the old domain, then adopts by the new one. */
export async function updateCompany(p: Principal, id: string, input: CompanyInput) {
  let adopted: string[] = [], released: string[] = [];
  let pending = false, affected: string[] = [];
  await inTx(async (tx) => {
    const cur = (await sql<{ domain: string | null; arr: string | null }>`
      SELECT domain, arr::text AS arr FROM core_company WHERE id = ${id}::uuid FOR UPDATE`.execute(tx)).rows[0];
    if (!cur) throw new ApiError('not_found', 'Not found.');
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.aliases !== undefined) patch.aliases = input.aliases;
    let arrChanged = false, domainChanged = false;
    if (input.arr !== undefined) { const a = parseArr(input.arr); arrChanged = Number(a ?? -1) !== Number(cur.arr ?? -1); patch.arr = a; }
    let domain = cur.domain;
    if (input.domain !== undefined) {
      domain = domainOrError(input.domain);
      domainChanged = domain !== cur.domain;
      if (domainChanged && domain) await assertDomainFree(tx, domain, id);
      patch.domain = domain;
    }
    if (domainChanged && cur.domain) {
      const r = await sql<{ id: string }>`
        UPDATE core_person SET company_id = NULL, company_source = NULL
        WHERE company_id = ${id}::uuid AND company_source = 'DOMAIN' AND split_part(email, '@', 2) = ${cur.domain} RETURNING id::text`.execute(tx);
      released = r.rows.map((x) => x.id);
    }
    if (Object.keys(patch).length) await tx.updateTable('core_company').set(patch).where('id', '=', id).execute();
    if (domainChanged && domain) adopted = await adopt(tx, id, domain);
    if (arrChanged || domainChanged) {
      affected = await ideaIdsFor(tx, [id], released);
      pending = await refreshAffected(tx, affected);
    }
    await audit({ actorKind: 'user', actorId: p.userId, action: 'fh.company.update', targetKind: 'company', targetId: id,
      details: { fields: Object.keys(patch), adopted: adopted.length, released: released.length } }, tx);
  });
  await afterRollups(affected, pending);
  return { ...(await companyDetail(id, true)), adopted: adopted.length, released: released.length, rollupsPending: pending };
}

/** FH-804: people are detached, insights lose their company, company links go. Counts are reported. */
export async function deleteCompanies(p: Principal, ids: string[]) {
  let out = { deleted: 0, peopleDetached: 0, insightsUnlinked: 0, linksRemoved: 0, rollupsPending: false };
  let affected: string[] = [];
  await inTx(async (tx) => {
    affected = await ideaIdsFor(tx, ids, []);
    const { rows } = await sql<{ people: number; insights: number; links: number }>`
      WITH pe AS (UPDATE core_person SET company_id = NULL, company_source = NULL WHERE company_id = ANY(${ids}::uuid[]) RETURNING 1),
           ins AS (UPDATE fh_insight SET company_id = NULL WHERE company_id = ANY(${ids}::uuid[]) RETURNING 1)
      SELECT (SELECT count(*) FROM pe)::int AS people, (SELECT count(*) FROM ins)::int AS insights,
             (SELECT count(*) FROM fh_idea_company WHERE company_id = ANY(${ids}::uuid[]))::int AS links`.execute(tx);
    const del = await sql<{ id: string }>`DELETE FROM core_company WHERE id = ANY(${ids}::uuid[]) RETURNING id::text`.execute(tx);
    const pending = await refreshAffected(tx, affected);
    out = { deleted: del.rows.length, peopleDetached: rows[0].people, insightsUnlinked: rows[0].insights, linksRemoved: rows[0].links, rollupsPending: pending };
    await audit({ actorKind: 'user', actorId: p.userId, action: 'fh.company.delete', details: { ids: del.rows.map((r) => r.id), ...out } }, tx);
  });
  await afterRollups(affected, out.rollupsPending);
  return out;
}

// ── people ──────────────────────────────────────────────────────────────────────────────────────────────
/**
 * FH-811 (and the pickers): most recently seen first. Emails only for feedback admins (DECISIONS: P2); the
 * pickers never get them. One statement.
 */
export async function listPeople(q: string | null, offset = 0, full = false, withEmails = false) {
  const term = likeTerm(q);
  const { rows } = await sql<Record<string, unknown> & { total?: number }>`
    SELECT p.id, COALESCE(p.display_name, 'Anonymous') AS name, p.verified_by AS "verifiedBy", c.name AS "companyName"
      ${full ? sql`, CASE WHEN ${withEmails} THEN p.email END AS email, p.display_name AS "displayName",
        p.verified_at IS NOT NULL AS verified, p.company_id AS "companyId", p.last_seen_at AS "lastSeenAt",
        (SELECT count(*) FROM fh_vote v WHERE v.person_id = p.id)::int AS "voteCount",
        (SELECT count(*) FROM fh_post po WHERE po.author_person_id = p.id)::int AS "postCount",
        (SELECT count(*) FROM fh_insight i WHERE i.person_id = p.id)::int AS "insightCount",
        count(*) OVER ()::int AS total` : sql``}
    FROM core_person p LEFT JOIN core_company c ON c.id = p.company_id
    WHERE ${term ? (full && withEmails || !full ? sql`(lower(p.display_name) LIKE ${term} OR p.email LIKE ${term})` : sql`lower(p.display_name) LIKE ${term}`) : sql`true`}
    ORDER BY p.last_seen_at DESC, p.id LIMIT ${PAGE} OFFSET ${offset}`.execute(getDb());
  const total = full ? (rows[0]?.total ?? 0) : undefined;
  return {
    people: rows.map(({ total: _t, ...r }) => { void _t; return { ...r, ...(r.lastSeenAt !== undefined && { lastSeenAt: iso(r.lastSeenAt) }) }; }),
    ...(full && { total, nextOffset: offset + rows.length < (total ?? 0) ? offset + rows.length : null }),
  };
}

/** FH-813: profile plus the last 50 posts, votes (with post title) and insights (with idea title). One statement. */
export async function personDetail(id: string, withEmails: boolean) {
  const { rows } = await sql<Record<string, unknown>>`
    SELECT p.id, CASE WHEN ${withEmails} THEN p.email END AS email, p.display_name AS "displayName",
      p.verified_at AS "verifiedAt", p.verified_by AS "verifiedBy", p.company_id AS "companyId", c.name AS "companyName",
      p.company_source AS "companySource", p.created_at AS "createdAt", p.last_seen_at AS "lastSeenAt",
      COALESCE((SELECT json_agg(x) FROM (SELECT po.id, po.title, po.vote_count AS "voteCount", po.created_at AS "createdAt"
        FROM fh_post po WHERE po.author_person_id = p.id ORDER BY po.created_at DESC LIMIT 50) x), '[]') AS posts,
      COALESCE((SELECT json_agg(x) FROM (SELECT v.id, v.post_id AS "postId", po.title AS "postTitle", v.created_at AS "createdAt"
        FROM fh_vote v JOIN fh_post po ON po.id = v.post_id WHERE v.person_id = p.id ORDER BY v.created_at DESC LIMIT 50) x), '[]') AS votes,
      COALESCE((SELECT json_agg(x) FROM (SELECT i.id, i.value, i.source, i.idea_id AS "ideaId", d.number::int AS "ideaNumber",
          d.title AS "ideaTitle", i.created_at AS "createdAt"
        FROM fh_insight i JOIN fh_idea d ON d.id = i.idea_id WHERE i.person_id = p.id ORDER BY i.created_at DESC LIMIT 50) x), '[]') AS insights
    FROM core_person p LEFT JOIN core_company c ON c.id = p.company_id WHERE p.id = ${id}::uuid`.execute(getDb());
  if (!rows[0]) throw new ApiError('not_found', 'Not found.');
  const r = rows[0];
  return { person: { ...r, verifiedAt: iso(r.verifiedAt), createdAt: iso(r.createdAt), lastSeenAt: iso(r.lastSeenAt) } };
}

/** FH-812: email normalised and unique; with no company, a company claiming the email's domain attributes them. */
export async function createPerson(p: Principal, input: { displayName?: string | null; email?: string | null; companyId?: string | null }) {
  const email = input.email ? normaliseEmail(input.email) : null;
  if (!email && !input.displayName) throw new ApiError('validation', 'Give a name or an email.', { field: 'displayName' });
  const id = newId();
  await inTx(async (tx) => {
    const r = await sql<{ id: string }>`
      INSERT INTO core_person (id, email, display_name, company_id, company_source)
      SELECT ${id}::uuid, ${email}, ${input.displayName ?? null},
             COALESCE(${input.companyId ?? null}::uuid, (SELECT c.id FROM core_company c WHERE c.domain = ${emailDomain(email)})),
             CASE WHEN ${input.companyId ?? null}::uuid IS NOT NULL THEN 'MANUAL'
                  WHEN EXISTS (SELECT 1 FROM core_company c WHERE c.domain = ${emailDomain(email)}) THEN 'DOMAIN' END
      ON CONFLICT (email) DO NOTHING RETURNING id::text`.execute(tx);
    if (!r.rows.length) throw new ApiError('conflict', 'A person with this email already exists.', { field: 'email' });
    await audit({ actorKind: 'user', actorId: p.userId, action: 'fh.person.create', targetKind: 'person', targetId: id }, tx);
  });
  return personDetail(id, true);
}

/** FH-814: display name and company (null detaches). A company change recomputes affected roll-ups (FH-505). */
export async function updatePerson(p: Principal, id: string, input: { displayName?: string | null; companyId?: string | null }) {
  let pending = false, affected: string[] = [];
  await inTx(async (tx) => {
    const cur = (await sql<{ company_id: string | null }>`SELECT company_id FROM core_person WHERE id = ${id}::uuid FOR UPDATE`.execute(tx)).rows[0];
    if (!cur) throw new ApiError('not_found', 'Not found.');
    const patch: Record<string, unknown> = {};
    if (input.displayName !== undefined) patch.display_name = input.displayName;
    const companyChanged = input.companyId !== undefined && input.companyId !== cur.company_id;
    if (companyChanged) { patch.company_id = input.companyId; patch.company_source = input.companyId ? 'MANUAL' : null; }
    if (Object.keys(patch).length) await tx.updateTable('core_person').set(patch).where('id', '=', id).execute();
    if (companyChanged) {
      affected = await ideaIdsFor(tx, null, [id]);
      pending = await refreshAffected(tx, affected);
    }
    await audit({ actorKind: 'user', actorId: p.userId, action: 'fh.person.update', targetKind: 'person', targetId: id, details: { fields: Object.keys(patch) } }, tx);
  });
  await afterRollups(affected, pending);
  return { ...(await personDetail(id, true)), rollupsPending: pending };
}

/**
 * `feedbackHub.erasePerson` (SEC-20 step 2) for a set of people, in its own transaction, ≤ 8 statements: delete their
 * votes and recount those posts; delete "people who asked"; clear post authors and insight people (the words stay);
 * drop requesterName / externalUserId / externalAccountId (and attachments of their support insights) from `meta`;
 * collect their support screenshots; clear them from vote events; recompute affected roll-ups.
 */
export async function erasePeople(personIds: string[]): Promise<{ counts: Record<string, number>; fileIds: string[] }> {
  const ids = uuids(personIds);
  return getDb().transaction().execute(async (tx) => {
    const { rows: [pre] } = await sql<{ ideas: string[] | null; files: string[] | null }>`
      SELECT ARRAY(SELECT DISTINCT idea_id::text FROM (${personIdeaIds(ids)}) x) AS ideas,
             ARRAY(SELECT f.id::text FROM core_file f JOIN fh_insight i ON f.owner_id = i.id::text
                   WHERE f.module = 'fh' AND f.owner_kind = 'insight' AND i.person_id = ANY(${ids}) AND i.source = 'SUPPORT_BUTTON') AS files`.execute(tx);
    const voted = await sql<{ post_id: string }>`DELETE FROM fh_vote WHERE person_id = ANY(${ids}) RETURNING post_id::text`.execute(tx);
    const posts = [...new Set(voted.rows.map((r) => r.post_id))];
    const recount = posts.length ? await sql`
      UPDATE fh_post p SET vote_count = (SELECT count(*) FROM fh_vote v WHERE v.post_id = p.id) WHERE p.id = ANY(${posts}::uuid[])`.execute(tx) : null;
    const links = await sql`DELETE FROM fh_idea_person WHERE person_id = ANY(${ids})`.execute(tx);
    // Their vote events keep the history without the person (P3); post authors are cleared (the words stay).
    await sql`WITH e AS (UPDATE fh_vote_event SET person_id = NULL WHERE person_id = ANY(${ids}))
      UPDATE fh_post SET author_person_id = NULL WHERE author_person_id = ANY(${ids})`.execute(tx);
    const ins = await sql`
      UPDATE fh_insight SET person_id = NULL,
        meta = CASE WHEN meta IS NULL THEN NULL
                    ELSE meta - 'requesterName' - 'externalUserId' - 'externalAccountId'
                         - (CASE WHEN source = 'SUPPORT_BUTTON' THEN 'attachments' ELSE '' END) END
      WHERE person_id = ANY(${ids})`.execute(tx);
    const ideas = pre.ideas ?? [];
    if (ideas.length) await refreshRollups(tx, ideas);
    return {
      counts: {
        votesDeleted: voted.rows.length, postsRecounted: Number(recount?.numAffectedRows ?? 0),
        peopleLinksRemoved: Number(links.numAffectedRows ?? 0), insightsUnattributed: Number(ins.numAffectedRows ?? 0),
        ideasRecomputed: ideas.length,
      },
      fileIds: pre.files ?? [],
    };
  });
}

export function erasureResponse(out: ErasureOutcome) {
  return { erased: out.erased.length, postsRecounted: out.counts.postsRecounted ?? 0, filesRemoved: out.counts.filesRemoved ?? 0, failed: out.failed };
}
