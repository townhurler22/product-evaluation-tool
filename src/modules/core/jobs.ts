// Postgres-backed job queue (§3.9, ARC-31; runner choice in DECISIONS).
// Idempotent handlers, exponential back-off, max 5 attempts, then 'dead' (shown in the admin console).
import { sql, type Kysely, type Transaction } from 'kysely';
import { getDb, type DB } from '@/server/db';
import { newId } from './util';

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;
const handlers = new Map<string, JobHandler>();

/** Modules register their job kinds at import time. */
export function registerJob(kind: string, handler: JobHandler) { handlers.set(kind, handler); }

export interface EnqueueOptions {
  /** One queued job per key; later enqueues push run_at out (debounce, §3.9). */
  dedupeKey?: string;
  delayMs?: number;
}

/** Call inside the writer's transaction or after commit; never publishes on its own (ARC-22). */
export async function enqueue(
  kind: string, payload: Record<string, unknown>, opts: EnqueueOptions = {},
  db: Kysely<DB> | Transaction<DB> = getDb(),
): Promise<void> {
  const runAt = new Date(Date.now() + (opts.delayMs ?? 0));
  const q = db.insertInto('core_job').values({
    id: newId(), kind, payload: JSON.stringify(payload), dedupe_key: opts.dedupeKey ?? null, run_at: runAt,
  });
  if (opts.dedupeKey) {
    await q.onConflict((oc) => oc.column('dedupe_key').where('state', '=', 'queued')
      .doUpdateSet({ run_at: runAt, payload: JSON.stringify(payload) })).execute();
  } else {
    await q.execute();
  }
}

const backoffMs = (attempt: number) => Math.min(60_000 * 2 ** (attempt - 1), 3_600_000);

/** Claims up to `limit` due jobs with SKIP LOCKED, runs them, records the outcome. */
export async function drainJobs(limit = 20): Promise<{ ran: number; failed: number }> {
  const db = getDb();
  // Only kinds this process can run: a function bundle that lacks a handler leaves the job for one that has it,
  // instead of burning an attempt and backing off (P5: jb.demand.notify must run within a second, D-27).
  const kinds = [...handlers.keys()];
  if (!kinds.length) return { ran: 0, failed: 0 };
  const claimed = await sql<{ id: string; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number }>`
    UPDATE core_job SET state = 'running', attempts = attempts + 1, locked_until = now() + interval '2 minutes'
    WHERE id IN (
      SELECT id FROM core_job
      WHERE ((state = 'queued' AND run_at <= now()) OR (state = 'running' AND locked_until < now()))
        AND kind = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(kinds)}::jsonb)))
      ORDER BY run_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id, kind, payload, attempts, max_attempts`.execute(db);

  let failed = 0;
  const done: string[] = [];
  for (const job of claimed.rows) {
    const handler = handlers.get(job.kind);
    try {
      if (!handler) throw new Error(`no handler for ${job.kind}`);
      await handler(job.payload);
      done.push(job.id);
    } catch (err) {
      failed += 1;
      const dead = job.attempts >= job.max_attempts;
      await db.updateTable('core_job').set({
        state: dead ? 'dead' : 'queued',
        run_at: new Date(Date.now() + backoffMs(job.attempts)),
        locked_until: null,
        last_error: String(err).slice(0, 1000),
        finished_at: dead ? new Date() : null,
      }).where('id', '=', job.id).execute();
    }
  }
  if (done.length) {
    await db.updateTable('core_job').set({ state: 'done', finished_at: new Date(), locked_until: null })
      .where('id', 'in', done).execute();
  }
  return { ran: claimed.rows.length, failed };
}
