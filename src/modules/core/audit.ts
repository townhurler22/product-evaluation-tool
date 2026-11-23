import type { Kysely, Transaction } from 'kysely';
import type { DB } from '@/server/db';
import { getDb } from '@/server/db';
import { newId } from './util';

export interface AuditEntry {
  actorKind: 'user' | 'visitor' | 'ingest' | 'system';
  actorId?: string | null;
  action: string;
  targetKind?: string;
  targetId?: string;
  /** Ids only, no personal data (SEC-25). */
  details?: Record<string, unknown>;
  ipHash?: string | null;
}

export async function audit(e: AuditEntry, db: Kysely<DB> | Transaction<DB> = getDb()): Promise<void> {
  await db.insertInto('core_audit_log').values({
    id: newId(),
    actor_kind: e.actorKind,
    actor_id: e.actorId ?? null,
    action: e.action,
    target_kind: e.targetKind ?? null,
    target_id: e.targetId ?? null,
    details: e.details ? JSON.stringify(e.details) : null,
    ip_hash: e.ipHash ?? null,
  }).execute();
}
