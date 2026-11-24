// Idea write operations (§7.4–7.9, 7.13). Each runs in one transaction with a fixed statement count, returns the
// changed rows in the list-row shape (PERF-01) and publishes them after the response (ARC-22).
import { sql } from 'kysely';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { audit, deleteFiles, enqueue, newId, type Principal } from '@/modules/core/service';
import {
  allowedTargets, canTransition, estimateFor, remapForType, roadmapDefaults, sameWorkflow, statusKeyOf, statusLabel,
  TYPE_LABEL, type BugStatus, type IdeaStatus, type IdeaType, type StatusKey,
} from './domain';
import { drainSoon, publishIdeas, publishRemoved } from './live';
import { rowById, rowsByIds, type IdeaRow } from './rows';
import type { PatchIdea } from './schemas';
import {
  assertWritable, insertEvents, insertStatusChanges, lockForWrite, lockIdeas, persistIdeas, refreshRollups,
  translateDbError, type Db, type EventInput, type IdeaState, type StatusChangeInput,
} from './store';
import { safeUrl } from './text';
import './jobs';

const yesNo = (b: boolean) => (b ? 'Yes' : 'No');
const enqueueMatch = (tx: Db, ideaId: string) =>
  enqueue('fh.match.compute', { ideaId }, { dedupeKey: `fh.match:${ideaId}`, delayMs: 0 }, tx);

async function inTx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  try {
    return await getDb().transaction().execute(fn);
  } catch (e) {
    throw translateDbError(e);
  }
}

/** Display labels for ids, for activity rows that must read well after a rename or delete. One statement. */
async function labels(db: Db, ids: { users?: (string | null)[]; features?: (string | null)[]; milestones?: (string | null)[] }) {
  const u = (ids.users ?? []).filter((x): x is string => !!x);
  const f = (ids.features ?? []).filter((x): x is string => !!x);
  const m = (ids.milestones ?? []).filter((x): x is string => !!x);
  const out = new Map<string, string>();
  if (!u.length && !f.length && !m.length) return out;
  const { rows } = await sql<{ id: string; label: string }>`
    SELECT id::text, COALESCE(full_name, email) AS label FROM core_user WHERE id = ANY(${u}::uuid[])
    UNION ALL SELECT id::text, name FROM fh_feature WHERE id = ANY(${f}::uuid[])
    UNION ALL SELECT id::text, name FROM fh_milestone WHERE id = ANY(${m}::uuid[])`.execute(db);
  for (const r of rows) out.set(r.id, r.label);
  return out;
}

// ── create (FH-201, FH-202, §4.4) ────────────────────────────────────────────
export async function createIdea(p: Principal, input: { title: string; ideaType?: IdeaType; featureId?: string | null; description?: string | null }): Promise<IdeaRow> {
  const id = newId();
  const type = input.ideaType ?? 'FEATURE_REQUEST';
  const isBug = type === 'BUG';
  await inTx(async (tx) => {
    await tx.insertInto('fh_idea').values({
      id, title: input.title, description: input.description ?? null, idea_type: type,
      status: isBug ? null : 'OPEN', bug_status: isBug ? 'OPEN' : null, feature_id: input.featureId ?? null,
      owner_id: p.userId, created_by: p.userId, // owned by its creator, born reviewed
    }).execute();
    await insertStatusChanges(tx, p.userId, [{ ideaId: id, from: null, to: isBug ? 'BUG_OPEN' : 'IDEA_OPEN' }]);
    await tx.insertInto('fh_idea_rollup').values({ idea_id: id }).execute();
    await enqueueMatch(tx, id);
  });
  const row = await rowById(getDb(), id);
  publishIdeas([row]);
  drainSoon();
  return row;
}

// ── patch (FH-303, PATCH ideas/:id) ──────────────────────────────────────────
const SIMPLE_FIELDS = [
  'estimateDays', 'strategicValue', 'revenueImpact', 'customerExperience', 'riskScore', 'effortScore',
] as const;

export async function patchIdea(p: Principal, id: string, body: PatchIdea): Promise<IdeaRow> {
  const { baseVersion, ...patch } = body;
  if (!Object.keys(patch).length) throw new ApiError('validation', 'Change at least one field.');
  let rematch = false;
  await inTx(async (tx) => {
    const cur = await lockForWrite(tx, id, baseVersion);
    const next: IdeaState = { ...cur };
    for (const [k, v] of Object.entries(patch)) (next as unknown as Record<string, unknown>)[k] = v;
    const status = statusKeyOf(next);
    if (next.isCommitted && !cur.isCommitted && (status === 'IDEA_OPEN' || status === 'BUG_OPEN')) {
      throw new ApiError('rule_violation', 'An idea in Open cannot be committed. Triage it first.', { field: 'isCommitted' });
    }
    if (next.startDate && next.dueDate && next.dueDate < next.startDate) {
      throw new ApiError('validation', 'The due date cannot be before the start date.', { field: 'dueDate' });
    }
    const events: EventInput[] = [];
    const ev = (field: string, from: string | null, to: string | null) => { if (from !== to) events.push({ ideaId: id, field, from, to }); };
    const names = (next.ownerId !== cur.ownerId || next.featureId !== cur.featureId || next.milestoneId !== cur.milestoneId)
      ? await labels(tx, { users: [cur.ownerId, next.ownerId], features: [cur.featureId, next.featureId], milestones: [cur.milestoneId, next.milestoneId] })
      : new Map<string, string>();
    const nm = (x: string | null) => (x ? names.get(x) ?? 'deleted' : null);
    if (next.title !== cur.title) { ev('title', cur.title, next.title); rematch = true; }
    if (next.description !== cur.description) { events.push({ ideaId: id, field: 'description', from: null, to: null }); rematch = true; }
    if (next.publicSummary !== cur.publicSummary) events.push({ ideaId: id, field: 'publicSummary', from: null, to: null });
    ev('owner', nm(cur.ownerId), nm(next.ownerId));
    ev('feature', nm(cur.featureId), nm(next.featureId));
    ev('milestone', nm(cur.milestoneId), nm(next.milestoneId));
    ev('startDate', cur.startDate, next.startDate);
    ev('dueDate', cur.dueDate, next.dueDate);
    for (const f of SIMPLE_FIELDS) ev(f, cur[f] === null ? null : String(cur[f]), next[f] === null ? null : String(next[f]));
    if (cur.isDealbreaker !== next.isDealbreaker) ev('isDealbreaker', yesNo(cur.isDealbreaker), yesNo(next.isDealbreaker));
    if (cur.isCommitted !== next.isCommitted) ev('isCommitted', yesNo(cur.isCommitted), yesNo(next.isCommitted));
    await persistIdeas(tx, [next]);
    await insertEvents(tx, p.userId, events);
    if (rematch) await enqueueMatch(tx, id);
  });
  const row = await rowById(getDb(), id);
  publishIdeas([row], { sections: rematch ? ['summary', 'activity', 'matches'] : ['summary', 'activity'] });
  if (rematch) drainSoon();
  return row;
}

// ── status (FH-301 to FH-306) ────────────────────────────────────────────────
interface StatusPlan { next: IdeaState; change: StatusChangeInput | null; events: EventInput[] }

/** Pure-ish planning of one status change; throws for the single-idea route, returns a reason for bulk. */
function planStatus(cur: IdeaState, to: StatusKey, comment: string | null | undefined, now: Date): StatusPlan | string {
  const from = statusKeyOf(cur);
  if (!from) return 'This idea has no valid status.';
  if (from === to) return { next: cur, change: null, events: [] }; // same status: allowed no-op
  if (!sameWorkflow(from, to)) {
    return to.startsWith('BUG_') ? 'Only bugs can take a bug status. Change the type instead.' : 'Bugs use the bug workflow. Change the type instead.';
  }
  if (!canTransition(from, to)) return `Cannot move from ${statusLabel(from)} to ${statusLabel(to)}.`;
  const next: IdeaState = { ...cur };
  if (to.startsWith('IDEA_')) next.status = to.slice(5) as IdeaStatus; else next.bugStatus = to.slice(4) as BugStatus;
  const events: EventInput[] = [];
  const dates = roadmapDefaults(to, cur, now); // FH-305
  if (dates.startDate !== cur.startDate) events.push({ ideaId: cur.id, field: 'startDate', from: cur.startDate, to: dates.startDate });
  if (dates.dueDate !== cur.dueDate) events.push({ ideaId: cur.id, field: 'dueDate', from: cur.dueDate, to: dates.dueDate });
  next.startDate = dates.startDate; next.dueDate = dates.dueDate;
  if ((to === 'IDEA_OPEN' || to === 'BUG_OPEN') && cur.isCommitted) { // FH-306
    next.isCommitted = false;
    events.push({ ideaId: cur.id, field: 'isCommitted', from: 'Yes', to: 'No' });
  }
  return { next, change: { ideaId: cur.id, from, to, comment: comment ?? null }, events };
}

export async function setStatus(p: Principal, id: string, to: StatusKey, comment: string | null | undefined, baseVersion?: number): Promise<IdeaRow> {
  let changed = false;
  await inTx(async (tx) => {
    const cur = await lockForWrite(tx, id, baseVersion);
    const plan = planStatus(cur, to, comment, new Date());
    if (typeof plan === 'string') throw new ApiError('validation', plan, { field: 'status' });
    if (!plan.change) return;
    changed = true;
    await persistIdeas(tx, [plan.next]);
    await insertStatusChanges(tx, p.userId, [plan.change]);
    await insertEvents(tx, p.userId, plan.events);
  });
  const row = await rowById(getDb(), id);
  if (changed) publishIdeas([row], { sections: ['activity'] });
  return row;
}

export interface BulkResult { rows: IdeaRow[]; skipped: { id: string; reason: string }[] }

export async function bulkStatus(p: Principal, ids: string[], to: StatusKey, comment?: string | null): Promise<BulkResult> {
  const skipped: BulkResult['skipped'] = [];
  const done: string[] = [];
  await inTx(async (tx) => {
    const cur = await lockIdeas(tx, ids);
    const plans: StatusPlan[] = [];
    const now = new Date();
    for (const id of ids) {
      const c = cur.get(id);
      if (!c) { skipped.push({ id, reason: 'Not found.' }); continue; }
      if (c.mergedIntoId) { skipped.push({ id, reason: 'Merged into another idea.' }); continue; }
      const plan = planStatus(c, to, comment, now);
      if (typeof plan === 'string') { skipped.push({ id, reason: plan }); continue; }
      if (plan.change) { plans.push(plan); done.push(id); }
    }
    await persistIdeas(tx, plans.map((x) => x.next));
    await insertStatusChanges(tx, p.userId, plans.map((x) => x.change!));
    await insertEvents(tx, p.userId, plans.flatMap((x) => x.events));
  });
  const rows = await rowsByIds(getDb(), done);
  publishIdeas(rows);
  return { rows, skipped };
}

// ── type change (FH-307) ─────────────────────────────────────────────────────
export async function setType(p: Principal, id: string, to: IdeaType, baseVersion?: number): Promise<IdeaRow> {
  let changed = false;
  await inTx(async (tx) => {
    const cur = await lockForWrite(tx, id, baseVersion);
    if (cur.ideaType === to) return; // same type: no-op
    changed = true;
    const mapped = remapForType(cur, to);
    const next: IdeaState = { ...cur, ideaType: to, ...mapped };
    await persistIdeas(tx, [next]);
    const from = statusKeyOf(cur), toKey = statusKeyOf(next)!;
    if (from !== toKey) {
      await insertStatusChanges(tx, p.userId, [{ ideaId: id, from, to: toKey, comment: `Type changed to ${TYPE_LABEL[to]}` }]);
    }
    await insertEvents(tx, p.userId, [{ ideaId: id, field: 'type', from: TYPE_LABEL[cur.ideaType], to: TYPE_LABEL[to] }]);
  });
  const row = await rowById(getDb(), id);
  if (changed) publishIdeas([row], { sections: ['activity'] });
  return row;
}

// ── dates (FH-766): never changes status ─────────────────────────────────────
export async function setDates(p: Principal, id: string, startDate: string, dueDate: string, baseVersion?: number): Promise<IdeaRow> {
  if (dueDate < startDate) throw new ApiError('validation', 'The due date cannot be before the start date.', { field: 'dueDate' });
  await inTx(async (tx) => {
    const cur = await lockForWrite(tx, id, baseVersion);
    const next: IdeaState = { ...cur, startDate, dueDate, estimateDays: estimateFor(startDate, dueDate) };
    const events: EventInput[] = [];
    if (cur.startDate !== startDate) events.push({ ideaId: id, field: 'startDate', from: cur.startDate, to: startDate });
    if (cur.dueDate !== dueDate) events.push({ ideaId: id, field: 'dueDate', from: cur.dueDate, to: dueDate });
    if (cur.estimateDays !== next.estimateDays) events.push({ ideaId: id, field: 'estimateDays', from: cur.estimateDays === null ? null : String(cur.estimateDays), to: String(next.estimateDays) });
    await persistIdeas(tx, [next]);
    await insertEvents(tx, p.userId, events);
  });
  const row = await rowById(getDb(), id);
  publishIdeas([row], { sections: ['activity'] });
  return row;
}

// ── whole-set replace: companies, people (≤ 100), themes (≤ 20) — FH-502, FH-703 ─────────
type SetKind = 'companies' | 'people' | 'themes';
const SET_TABLE = {
  companies: { link: 'fh_idea_company', col: 'company_id', target: 'core_company', label: sql`name` },
  people: { link: 'fh_idea_person', col: 'person_id', target: 'core_person', label: sql`COALESCE(display_name, email, 'Anonymous')` },
  themes: { link: 'fh_idea_theme', col: 'theme_id', target: 'fh_theme', label: sql`name` },
} as const;

export async function replaceSet(p: Principal, id: string, kind: SetKind, rawIds: string[], baseVersion?: number) {
  const ids = [...new Set(rawIds)];
  const t = SET_TABLE[kind];
  const linkTable = t.link;
  let items: { id: string; name: string }[] = [];
  let changed = false;
  await inTx(async (tx) => {
    const cur = await lockForWrite(tx, id, baseVersion);
    // All ids must exist (400 otherwise). The same statement reads the current set with names for activity.
    const { rows } = await sql<{ id: string; name: string; wanted: boolean; current: boolean }>`
      SELECT x.id::text, ${t.label} AS name, x.id = ANY(${ids}::uuid[]) AS wanted,
             EXISTS (SELECT 1 FROM ${sql.table(linkTable)} l WHERE l.idea_id = ${id}::uuid AND ${sql.ref('l.' + t.col)} = x.id) AS current
      FROM ${sql.table(t.target)} x
      WHERE x.id = ANY(${ids}::uuid[]) OR x.id IN (SELECT ${sql.ref('l.' + t.col)} FROM ${sql.table(linkTable)} l WHERE l.idea_id = ${id}::uuid)`.execute(tx);
    const found = new Set(rows.filter((r) => r.wanted).map((r) => r.id));
    if (found.size !== ids.length) throw new ApiError('validation', 'Some of those records do not exist.', { field: 'ids' });
    const add = rows.filter((r) => r.wanted && !r.current).map((r) => r.id);
    const remove = rows.filter((r) => !r.wanted && r.current).map((r) => r.id);
    items = rows.filter((r) => r.wanted).map((r) => ({ id: r.id, name: r.name })).sort((a, b) => a.name.localeCompare(b.name));
    if (!add.length && !remove.length) return;
    changed = true;
    if (remove.length) {
      await sql`DELETE FROM ${sql.table(linkTable)} WHERE idea_id = ${id}::uuid AND ${sql.ref(t.col)} = ANY(${remove}::uuid[])`.execute(tx);
    }
    if (add.length) {
      await sql`INSERT INTO ${sql.table(linkTable)} (idea_id, ${sql.ref(t.col)})
                SELECT ${id}::uuid, unnest(${add}::uuid[]) ON CONFLICT DO NOTHING`.execute(tx);
    }
    await persistIdeas(tx, [cur]); // version bump (INV-12)
    if (kind === 'themes') {
      const sorted = (xs: { name: string }[]) => xs.map((x) => x.name).sort((a, b) => a.localeCompare(b)).join(', ') || 'none';
      await insertEvents(tx, p.userId, [{ ideaId: id, field: 'themes', from: sorted(rows.filter((r) => r.current)), to: sorted(items) }]);
    } else {
      await refreshRollups(tx, [id]);
    }
  });
  const row = await rowById(getDb(), id);
  if (changed) publishIdeas([row], { sections: kind === 'themes' ? ['summary', 'activity'] : ['summary', 'evidence'] });
  return { row, items };
}

// ── evidence (FH-501, FH-503) ────────────────────────────────────────────────
export async function addInsight(p: Principal, ideaId: string, input: {
  value: string; companyId?: string | null; personId?: string | null; priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'DEALBREAKER'; url?: string | null;
}) {
  let url: string | null = null;
  if (input.url) {
    url = safeUrl(input.url);
    if (!url) throw new ApiError('validation', 'Links must start with http:// or https://.', { field: 'url' });
  }
  const insightId = newId();
  await inTx(async (tx) => {
    const cur = await lockForWrite(tx, ideaId);
    const { rows } = await sql<{ c: number; p: number }>`
      SELECT (SELECT count(*)::int FROM core_company WHERE id = ${input.companyId ?? null}::uuid) AS c,
             (SELECT count(*)::int FROM core_person WHERE id = ${input.personId ?? null}::uuid) AS p`.execute(tx);
    if (input.companyId && !rows[0].c) throw new ApiError('validation', 'That company does not exist.', { field: 'companyId' });
    if (input.personId && !rows[0].p) throw new ApiError('validation', 'That person does not exist.', { field: 'personId' });
    await tx.insertInto('fh_insight').values({
      id: insightId, idea_id: ideaId, value: input.value, source: 'MANUAL', // FH-501: always Manual
      company_id: input.companyId ?? null, person_id: input.personId ?? null, priority: input.priority ?? 'MEDIUM',
      url, created_by: p.userId,
    }).execute();
    // INV-13: naming a company or person implies the "who asked" link, idempotently.
    if (input.companyId) {
      await tx.insertInto('fh_idea_company').values({ idea_id: ideaId, company_id: input.companyId }).onConflict((oc) => oc.doNothing()).execute();
    }
    if (input.personId) {
      await tx.insertInto('fh_idea_person').values({ idea_id: ideaId, person_id: input.personId }).onConflict((oc) => oc.doNothing()).execute();
    }
    await persistIdeas(tx, [cur]);
    await refreshRollups(tx, [ideaId]);
  });
  const row = await rowById(getDb(), ideaId);
  publishIdeas([row], { sections: ['summary', 'evidence'] });
  return { insightId, row };
}

export async function deleteInsight(p: Principal, insightId: string): Promise<{ row: IdeaRow | null; filesRemoved: number }> {
  void p;
  const found = await getDb().selectFrom('fh_insight').select('idea_id').where('id', '=', insightId).executeTakeFirst();
  if (!found) return { row: null, filesRemoved: 0 }; // FH-503: idempotent
  let fileIds: string[] = [];
  await inTx(async (tx) => {
    const cur = (await lockIdeas(tx, [found.idea_id])).get(found.idea_id);
    if (!cur) return;
    const files = await tx.selectFrom('core_file').select('id')
      .where('module', '=', 'fh').where('owner_kind', '=', 'insight').where('owner_id', '=', insightId).execute();
    fileIds = files.map((f) => f.id);
    await tx.deleteFrom('fh_insight').where('id', '=', insightId).execute();
    await persistIdeas(tx, [cur]);
    await refreshRollups(tx, [found.idea_id]);
  });
  const filesRemoved = fileIds.length ? await deleteFiles(fileIds) : 0; // after commit (ARC-29)
  const row = (await rowsByIds(getDb(), [found.idea_id]))[0] ?? null;
  if (row) publishIdeas([row], { sections: ['summary', 'evidence'] });
  return { row, filesRemoved };
}

// ── merge (FH-451 to FH-455) ─────────────────────────────────────────────────
export async function mergeIdeas(p: Principal, sourceId: string, targetId: string) {
  if (sourceId === targetId) throw new ApiError('conflict', 'An idea cannot be merged into itself.');
  await inTx(async (tx) => {
    const locked = await lockIdeas(tx, [sourceId, targetId]);
    const s = locked.get(sourceId), t = locked.get(targetId);
    if (!s || !t) throw new ApiError('not_found', 'Not found.');
    if (s.mergedIntoId) throw new ApiError('conflict', 'This idea has already been merged.');
    if (t.mergedIntoId) throw new ApiError('conflict', 'The target idea has been merged into another, so it cannot take more.');
    const moved = await sql<{ id: string }>`UPDATE fh_insight SET idea_id = ${targetId}::uuid WHERE idea_id = ${sourceId}::uuid RETURNING id::text`.execute(tx);
    // Copy then delete each link set, skipping duplicates. One statement per table.
    const movedLinks: Record<string, string[]> = {};
    for (const [table, col] of [['fh_idea_company', 'company_id'], ['fh_idea_person', 'person_id'], ['fh_idea_post', 'post_id'],
      ['fh_idea_theme', 'theme_id'], ['fh_idea_journey', 'journey_id']] as const) {
      const { rows } = await sql<{ ids: string[] | null }>`
        WITH d AS (DELETE FROM ${sql.table(table)} WHERE idea_id = ${sourceId}::uuid RETURNING ${sql.ref(col)} AS x),
             ins AS (INSERT INTO ${sql.table(table)} (idea_id, ${sql.ref(col)}) SELECT ${targetId}::uuid, x FROM d ON CONFLICT DO NOTHING)
        SELECT array_agg(x::text) AS ids FROM d`.execute(tx);
      movedLinks[table] = rows[0]?.ids ?? [];
    }
    await persistIdeas(tx, [{ ...s, mergedIntoId: targetId }, t]);
    await refreshRollups(tx, [sourceId, targetId]);
    await tx.insertInto('fh_merge_event').values({
      id: newId(), source_idea_id: sourceId, target_idea_id: targetId, actor_id: p.userId,
      snapshot: JSON.stringify({
        title: s.title, description: s.description, ideaType: s.ideaType, status: s.status, bugStatus: s.bugStatus,
        ownerId: s.ownerId, featureId: s.featureId, startDate: s.startDate, dueDate: s.dueDate,
        moved: { insights: moved.rows.map((r) => r.id), ...movedLinks },
      }),
    }).execute();
    await insertEvents(tx, p.userId, [
      { ideaId: targetId, field: 'merge', from: null, to: `Merged #${s.number} into this` },
      { ideaId: sourceId, field: 'merge', from: null, to: `Merged into #${t.number}` },
    ]);
    await audit({ actorKind: 'user', actorId: p.userId, action: 'fh.idea.merge', targetKind: 'idea', targetId: sourceId, details: { targetId } }, tx);
  });
  const target = await rowById(getDb(), targetId);
  publishRemoved([{ id: sourceId, mergedIntoId: targetId }]);
  publishIdeas([target], { sections: ['summary', 'evidence', 'activity'] });
  // FH-454: distinct voters can go down when the same person voted on both posts.
  return { target, sourceId, distinctVoters: target.distinctVoters };
}

// ── delete (FH-455, FH-456) ──────────────────────────────────────────────────
export async function deleteIdeas(p: Principal, ids: string[]): Promise<{ deleted: number; filesRemoved: number; ids: string[] }> {
  let fileIds: string[] = [];
  let deleted: string[] = [];
  await inTx(async (tx) => {
    const files = await sql<{ id: string }>`
      SELECT f.id::text FROM core_file f WHERE f.module = 'fh' AND f.owner_kind = 'insight'
        AND f.owner_id IN (SELECT id::text FROM fh_insight WHERE idea_id = ANY(${ids}::uuid[]))`.execute(tx);
    fileIds = files.rows.map((r) => r.id);
    // Live ideas only; insights, themes, history, activity, comments, matches and links cascade. Posts are kept.
    const res = await sql<{ id: string }>`DELETE FROM fh_idea WHERE id = ANY(${ids}::uuid[]) AND merged_into_id IS NULL RETURNING id::text`.execute(tx);
    deleted = res.rows.map((r) => r.id);
    await audit({ actorKind: 'user', actorId: p.userId, action: 'fh.idea.delete', details: { ids: deleted, count: deleted.length } }, tx);
  });
  const filesRemoved = fileIds.length ? await deleteFiles(fileIds) : 0; // never fails the delete (ARC-29)
  publishRemoved(deleted.map((id) => ({ id })));
  return { deleted: deleted.length, filesRemoved, ids: deleted };
}

// ── bulk accept (FH-402), bulk themes (FH-153), milestone assign (FH-752) ─────
export async function bulkAccept(p: Principal, ids: string[]): Promise<BulkResult> {
  const skipped: BulkResult['skipped'] = [];
  const done: IdeaState[] = [];
  await inTx(async (tx) => {
    const cur = await lockIdeas(tx, ids);
    const now = new Date().toISOString();
    for (const id of ids) {
      const c = cur.get(id);
      if (!c) skipped.push({ id, reason: 'Not found.' });
      else if (c.mergedIntoId) skipped.push({ id, reason: 'Merged into another idea.' });
      else if (c.reviewedAt) skipped.push({ id, reason: 'Already reviewed.' });
      else done.push({ ...c, reviewedAt: now }); // never changes status (INV-06)
    }
    await persistIdeas(tx, done);
    await insertEvents(tx, p.userId, done.map((c) => ({ ideaId: c.id, field: 'reviewed', from: 'Unreviewed', to: 'Accepted' })));
  });
  const rows = await rowsByIds(getDb(), done.map((d) => d.id));
  publishIdeas(rows);
  return { rows, skipped };
}

export async function bulkThemes(p: Principal, ids: string[], themeId: string, action: 'add' | 'remove'): Promise<BulkResult> {
  const skipped: BulkResult['skipped'] = [];
  const changed: IdeaState[] = [];
  await inTx(async (tx) => {
    const cur = await lockIdeas(tx, ids);
    const { rows } = await sql<{ idea_id: string | null; theme_id: string; name: string; target: boolean }>`
      SELECT it.idea_id::text, t.id::text AS theme_id, t.name, t.id = ${themeId}::uuid AS target
      FROM fh_theme t LEFT JOIN fh_idea_theme it ON it.theme_id = t.id AND it.idea_id = ANY(${ids}::uuid[])
      WHERE t.id = ${themeId}::uuid OR it.idea_id IS NOT NULL`.execute(tx);
    const theme = rows.find((r) => r.target);
    if (!theme) throw new ApiError('validation', 'That theme does not exist.', { field: 'themeId' });
    const namesByIdea = new Map<string, string[]>();
    for (const r of rows) if (r.idea_id) namesByIdea.set(r.idea_id, [...(namesByIdea.get(r.idea_id) ?? []), r.name]);
    const events: EventInput[] = [];
    for (const id of ids) {
      const c = cur.get(id);
      if (!c) { skipped.push({ id, reason: 'Not found.' }); continue; }
      if (c.mergedIntoId) { skipped.push({ id, reason: 'Merged into another idea.' }); continue; }
      const has = rows.some((r) => r.idea_id === id && r.target);
      if ((action === 'add') === has) continue; // already in the wanted state
      const before = (namesByIdea.get(id) ?? []).sort((a, b) => a.localeCompare(b));
      const after = action === 'add' ? [...before, theme.name].sort((a, b) => a.localeCompare(b)) : before.filter((n) => n !== theme.name);
      events.push({ ideaId: id, field: 'themes', from: before.join(', ') || 'none', to: after.join(', ') || 'none' });
      changed.push(c);
    }
    const changedIds = changed.map((c) => c.id);
    if (changedIds.length) {
      if (action === 'add') {
        await sql`INSERT INTO fh_idea_theme (idea_id, theme_id) SELECT unnest(${changedIds}::uuid[]), ${themeId}::uuid ON CONFLICT DO NOTHING`.execute(tx);
      } else {
        await sql`DELETE FROM fh_idea_theme WHERE theme_id = ${themeId}::uuid AND idea_id = ANY(${changedIds}::uuid[])`.execute(tx);
      }
    }
    await persistIdeas(tx, changed);
    await insertEvents(tx, p.userId, events);
  });
  const rows = await rowsByIds(getDb(), changed.map((c) => c.id));
  publishIdeas(rows);
  return { rows, skipped };
}

export async function assignMilestone(p: Principal, ids: string[], milestoneId: string | null): Promise<BulkResult & { changed: number }> {
  const skipped: BulkResult['skipped'] = [];
  const changed: IdeaState[] = [];
  await inTx(async (tx) => {
    const cur = await lockIdeas(tx, ids);
    const old = [...cur.values()].map((c) => c.milestoneId);
    const names = await labels(tx, { milestones: [...old, milestoneId] });
    if (milestoneId && !names.has(milestoneId)) throw new ApiError('validation', 'That milestone does not exist.', { field: 'milestoneId' });
    const events: EventInput[] = [];
    for (const id of ids) {
      const c = cur.get(id);
      if (!c) { skipped.push({ id, reason: 'Not found.' }); continue; }
      if (c.mergedIntoId) { skipped.push({ id, reason: 'Merged into another idea.' }); continue; }
      if (c.milestoneId === milestoneId) continue;
      // Assigning a milestone never moves an idea's dates (FH-752).
      events.push({ ideaId: id, field: 'milestone', from: c.milestoneId ? names.get(c.milestoneId) ?? 'deleted' : null, to: milestoneId ? names.get(milestoneId)! : null });
      changed.push({ ...c, milestoneId });
    }
    await persistIdeas(tx, changed);
    await insertEvents(tx, p.userId, events);
  });
  const rows = await rowsByIds(getDb(), changed.map((c) => c.id));
  publishIdeas(rows);
  return { rows, skipped, changed: rows.length };
}

export { allowedTargets, assertWritable };
