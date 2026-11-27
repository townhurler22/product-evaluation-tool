// Erasure of external people (SEC-20, FH-815). Core orchestrates; each module erases what it holds through a
// registered participant (`feedbackHub.erasePerson`, `journeyBoards.erasePerson`), so Core never reads module tables.
// Sequence: audit "requested" → participants (each in its own transaction) → delete collected files → delete the
// person rows last → audit "completed" with counts only. Every step is idempotent; a failure enqueues `core.erasure`,
// which re-runs the whole sequence from the participants.
import { sql } from 'kysely';
import { getDb } from '@/server/db';
import { deleteFiles } from './files/service';
import { enqueue, registerJob } from './jobs';
import { newId } from './util';

export interface ErasureResult { counts: Record<string, number>; fileIds: string[] }
/** Takes a set of person ids (ARC-02) and runs in its own transaction (ARC-21). */
export type ErasureParticipant = (personIds: string[]) => Promise<ErasureResult>;

const participants = new Map<string, ErasureParticipant>();

export function registerErasureParticipant(module: string, fn: ErasureParticipant) { participants.set(module, fn); }

export interface ErasureOutcome {
  erased: string[];
  counts: Record<string, number>;
  failed: { id: string; reason: string }[];
}

async function auditRows(action: string, actorKind: 'user' | 'system', actorId: string | null, ids: string[], details?: Record<string, unknown>) {
  if (!ids.length) return;
  // Ids and counts only (SEC-25): no names or emails.
  await getDb().insertInto('core_audit_log').values(ids.map((id) => ({
    id: newId(), actor_kind: actorKind, actor_id: actorId, action, target_kind: 'person', target_id: id,
    details: details ? JSON.stringify(details) : null,
  }))).execute();
}

/**
 * Erases up to 100 people. Unknown ids are reported as failed. Statements: 1 existence check, 1 audit, the
 * participants' own (Feedback Hub ≤ 10), ≤ 2 for files, 1 delete, 1 audit.
 */
export async function runErasure(actor: { kind: 'user' | 'system'; id: string | null }, rawIds: string[]): Promise<ErasureOutcome> {
  const ids = [...new Set(rawIds)];
  const db = getDb();
  const existing = new Set((await sql<{ id: string }>`SELECT id::text FROM core_person WHERE id = ANY(${ids}::uuid[])`.execute(db)).rows.map((r) => r.id));
  const failed = ids.filter((id) => !existing.has(id)).map((id) => ({ id, reason: 'Not found.' }));
  const todo = ids.filter((id) => existing.has(id));
  if (!todo.length) return { erased: [], counts: {}, failed };

  await auditRows('core.person.erase.requested', actor.kind, actor.id, todo);
  try {
    const out = await eraseSequence(todo);
    await auditRows('core.person.erase.completed', actor.kind, actor.id, out.erased, out.counts);
    return { erased: out.erased, counts: out.counts, failed };
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'erasure failed; queued for retry', count: todo.length, err: String(e) }));
    await enqueue('core.erasure', { personIds: todo, actorId: actor.id }).catch(() => {});
    return { erased: [], counts: {}, failed: [...failed, ...todo.map((id) => ({ id, reason: 'Erasure is queued to retry.' }))] };
  }
}

async function eraseSequence(ids: string[]): Promise<{ erased: string[]; counts: Record<string, number> }> {
  const counts: Record<string, number> = {};
  const fileIds: string[] = [];
  for (const [, run] of participants) {
    const r = await run(ids);
    for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + v;
    fileIds.push(...r.fileIds);
  }
  // A storage failure marks the rows for the nightly sweep and never blocks the erasure (ARC-29).
  counts.filesRemoved = fileIds.length ? await deleteFiles(fileIds) : 0;
  const del = await sql<{ id: string }>`DELETE FROM core_person WHERE id = ANY(${ids}::uuid[]) RETURNING id::text`.execute(getDb());
  return { erased: del.rows.map((r) => r.id), counts };
}

registerJob('core.erasure', async (payload) => {
  const ids = Array.isArray(payload.personIds) ? payload.personIds.filter((x): x is string => typeof x === 'string') : [];
  if (!ids.length) return;
  const out = await eraseSequence(ids); // throws to retry with back-off; dead letters alert (ARC-31)
  await auditRows('core.person.erase.completed', 'system', null, out.erased, out.counts);
});
