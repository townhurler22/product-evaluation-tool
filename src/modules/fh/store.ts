// Idea persistence primitives. Every idea write goes through `lockIdeas` → change in memory → `persistIdeas`,
// so every write bumps the version (INV-12) and costs a fixed number of statements whatever the batch size (PERF-03).
import { sql, type Kysely, type Transaction } from 'kysely';
import { getDb, type DB } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { newId } from '@/modules/core/service';
import type { BugStatus, IdeaStatus, IdeaType, StatusKey } from './domain';

export type Db = Kysely<DB> | Transaction<DB>;

export interface IdeaState {
  id: string;
  number: number;
  title: string;
  description: string | null;
  ideaType: IdeaType;
  status: IdeaStatus | null;
  bugStatus: BugStatus | null;
  featureId: string | null;
  milestoneId: string | null;
  ownerId: string | null;
  mergedIntoId: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimateDays: number | null;
  strategicValue: number | null;
  revenueImpact: number | null;
  customerExperience: number | null;
  riskScore: number | null;
  effortScore: number | null;
  isDealbreaker: boolean;
  isCommitted: boolean;
  reviewedAt: string | null;
  publicSummary: string | null;
  version: number;
}

const STATE_SQL = sql`
  id, number::int AS "number", title, description, idea_type AS "ideaType", status, bug_status AS "bugStatus",
  feature_id AS "featureId", milestone_id AS "milestoneId", owner_id AS "ownerId", merged_into_id AS "mergedIntoId",
  start_date::text AS "startDate", due_date::text AS "dueDate", estimate_days AS "estimateDays",
  strategic_value AS "strategicValue", revenue_impact AS "revenueImpact", customer_experience AS "customerExperience",
  risk_score AS "riskScore", effort_score AS "effortScore", is_dealbreaker AS "isDealbreaker",
  is_committed AS "isCommitted", reviewed_at::text AS "reviewedAt", public_summary AS "publicSummary", version`;

/** Locks and reads ideas in id order (stable lock order avoids deadlocks). One statement. */
export async function lockIdeas(tx: Db, ids: string[]): Promise<Map<string, IdeaState>> {
  if (!ids.length) return new Map();
  const { rows } = await sql<IdeaState>`SELECT ${STATE_SQL} FROM fh_idea WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`.execute(tx);
  return new Map(rows.map((r) => [r.id, r]));
}

/** Reads one idea without locking. One statement. */
export async function readIdea(db: Db, id: string): Promise<IdeaState | null> {
  const { rows } = await sql<IdeaState>`SELECT ${STATE_SQL} FROM fh_idea WHERE id = ${id}::uuid`.execute(db);
  return rows[0] ?? null;
}

/** Locks one idea for a write: 404 if missing, 409 if merged (FH-455), 409 on a stale baseVersion (FH-303). */
export async function lockForWrite(tx: Db, id: string, baseVersion?: number | null): Promise<IdeaState> {
  const cur = (await lockIdeas(tx, [id])).get(id);
  if (!cur) throw new ApiError('not_found', 'Not found.');
  assertWritable(cur, baseVersion);
  return cur;
}

export function assertWritable(cur: IdeaState, baseVersion?: number | null) {
  if (cur.mergedIntoId) throw new ApiError('conflict', 'This idea has been merged into another.', { mergedIntoId: cur.mergedIntoId });
  if (baseVersion !== undefined && baseVersion !== null && baseVersion !== cur.version) {
    throw new ApiError('conflict', 'This idea changed since you loaded it.', { version: cur.version });
  }
}

/** Writes the full new state of each idea and bumps its version. One statement for any number of ideas. */
export async function persistIdeas(tx: Db, states: IdeaState[]): Promise<void> {
  if (!states.length) return;
  const payload = JSON.stringify(states.map((s) => ({
    id: s.id, title: s.title, description: s.description, idea_type: s.ideaType, status: s.status, bug_status: s.bugStatus,
    feature_id: s.featureId, milestone_id: s.milestoneId, owner_id: s.ownerId, merged_into_id: s.mergedIntoId,
    start_date: s.startDate, due_date: s.dueDate, estimate_days: s.estimateDays, strategic_value: s.strategicValue,
    revenue_impact: s.revenueImpact, customer_experience: s.customerExperience, risk_score: s.riskScore,
    effort_score: s.effortScore, is_dealbreaker: s.isDealbreaker, is_committed: s.isCommitted,
    reviewed_at: s.reviewedAt, public_summary: s.publicSummary,
  })));
  try {
    await sql`
      UPDATE fh_idea i SET
        title = v.title, description = v.description, idea_type = v.idea_type, status = v.status, bug_status = v.bug_status,
        feature_id = v.feature_id, milestone_id = v.milestone_id, owner_id = v.owner_id, merged_into_id = v.merged_into_id,
        start_date = v.start_date, due_date = v.due_date, estimate_days = v.estimate_days,
        strategic_value = v.strategic_value, revenue_impact = v.revenue_impact, customer_experience = v.customer_experience,
        risk_score = v.risk_score, effort_score = v.effort_score, is_dealbreaker = v.is_dealbreaker,
        is_committed = v.is_committed, reviewed_at = v.reviewed_at, public_summary = v.public_summary,
        version = i.version + 1, updated_at = now()
      FROM jsonb_to_recordset(${payload}::jsonb) AS v(
        id uuid, title text, description text, idea_type text, status text, bug_status text, feature_id uuid,
        milestone_id uuid, owner_id uuid, merged_into_id uuid, start_date date, due_date date, estimate_days int,
        strategic_value smallint, revenue_impact smallint, customer_experience smallint, risk_score smallint,
        effort_score smallint, is_dealbreaker bool, is_committed bool, reviewed_at timestamptz, public_summary text)
      WHERE i.id = v.id`.execute(tx);
  } catch (e) {
    throw translateDbError(e);
  }
}

/** Maps constraint failures to 400s that name the field, instead of a 500 (ARC-08). */
export function translateDbError(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string; message?: string };
  const msg = String(err.message ?? '');
  if (err.code === '23503' || /foreign key/.test(msg)) {
    const field = /owner/.test(msg) ? 'ownerId' : /feature/.test(msg) ? 'featureId' : /milestone/.test(msg) ? 'milestoneId'
      : /company/.test(msg) ? 'companyId' : /person/.test(msg) ? 'personId' : /theme/.test(msg) ? 'themeIds' : undefined;
    return new ApiError('validation', 'That record does not exist.', field ? { field } : undefined);
  }
  if (err.code === '23514' || /check constraint/.test(msg)) {
    return new ApiError('validation', 'That value is not allowed.');
  }
  return e;
}

export interface EventInput { ideaId: string; field: string; from: string | null; to: string | null; actorLabel?: string | null }
export interface StatusChangeInput { ideaId: string; from: StatusKey | null; to: StatusKey; comment?: string | null }

/** Field activity rows (append-only). One statement. */
export async function insertEvents(tx: Db, actorId: string | null, events: EventInput[]): Promise<void> {
  if (!events.length) return;
  await tx.insertInto('fh_idea_event').values(events.map((e) => ({
    id: newId(), idea_id: e.ideaId, actor_id: actorId, actor_label: e.actorLabel ?? null, field: e.field,
    from_value: e.from, to_value: e.to,
  }))).execute();
}

/** INV-02: every status change writes history in the same transaction. One statement. */
export async function insertStatusChanges(tx: Db, actorId: string | null, changes: StatusChangeInput[]): Promise<void> {
  if (!changes.length) return;
  await tx.insertInto('fh_status_change').values(changes.map((c) => ({
    id: newId(), idea_id: c.ideaId, from_status: c.from, to_status: c.to, actor_id: actorId, comment: c.comment ?? null,
  }))).execute();
}

/** FH-504 roll-up for a set of ideas, same transaction as the write. One statement. */
export async function refreshRollups(tx: Db, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await sql`SELECT fh_rollup_refresh(${ids}::uuid[])`.execute(tx);
}

export const dbOrDefault = (db?: Db) => db ?? getDb();
