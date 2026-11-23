// Intake client, key, review and pause management (ING-28 to ING-31, ING-35). Workspace admins only.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { audit } from '../audit';
import { newId } from '../util';
import { deploymentEnvironment, deriveSecret, masterKey } from './signing';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const newKeyId = () => 'ik_' + Array.from(randomBytes(16), (b) => B32[b & 31]).join('');

export interface ClientInput {
  name: string;
  environment: 'staging' | 'production';
  routes: string[];
  target?: string | null;
  ratePerMinute?: number;
}

export async function createClient(actorId: string, input: ClientInput) {
  const id = newId();
  try {
    await getDb().insertInto('ing_client').values({
      id, name: input.name.trim(), environment: input.environment, routes: input.routes,
      target: input.target ?? null, rate_per_minute: input.ratePerMinute ?? 60, created_by: actorId,
    }).execute();
  } catch (e) {
    if (String(e).includes('ing_client_name_key') || String(e).includes('unique')) {
      throw new ApiError('conflict', 'A client with this name already exists.', { field: 'name' });
    }
    throw e;
  }
  await audit({ actorKind: 'user', actorId, action: 'ing.client.create', targetKind: 'ing_client', targetId: id });
  return getClient(id);
}

export async function getClient(id: string) {
  const c = await getDb().selectFrom('ing_client').selectAll().where('id', '=', id).executeTakeFirst();
  if (!c) throw new ApiError('not_found', 'Not found.');
  return c;
}

export async function updateClient(actorId: string, id: string, patch: { routes?: string[]; ratePerMinute?: number }) {
  const r = await getDb().updateTable('ing_client').set({
    ...(patch.routes && { routes: patch.routes }),
    ...(patch.ratePerMinute && { rate_per_minute: patch.ratePerMinute }),
  }).where('id', '=', id).executeTakeFirst();
  if (!r.numUpdatedRows) throw new ApiError('not_found', 'Not found.');
  await audit({ actorKind: 'user', actorId, action: 'ing.client.update', targetKind: 'ing_client', targetId: id, details: { fields: Object.keys(patch) } });
  return getClient(id);
}

/**
 * ING-28: issue a key. The derived secret is returned exactly once and never logged or stored.
 * ING-30: production keys need a gateway review and a client review.
 */
export async function issueKey(actorId: string, clientId: string): Promise<{ keyId: string; secret: string }> {
  const master = masterKey();
  if (!master) throw new ApiError('unavailable', 'Intake master key is not configured.');
  const keyId = newKeyId();
  const secret = await getDb().transaction().execute(async (tx) => {
    const client = (await sql<{ id: string; environment: 'staging' | 'production'; module: string }>`
      SELECT id, environment, module FROM ing_client WHERE id = ${clientId} FOR UPDATE`.execute(tx)).rows[0];
    if (!client) throw new ApiError('not_found', 'Not found.');
    if (client.environment !== deploymentEnvironment()) {
      throw new ApiError('rule_violation', `This deployment issues ${deploymentEnvironment()} keys only.`);
    }
    if (client.environment === 'production') {
      const reviews = await tx.selectFrom('ing_review').select('kind')
        .where((eb) => eb.or([eb('kind', '=', 'gateway'), eb.and([eb('kind', '=', 'client'), eb('client_id', '=', clientId)])]))
        .execute();
      const kinds = new Set(reviews.map((r) => r.kind));
      if (!kinds.has('gateway') || !kinds.has('client')) {
        throw new ApiError('rule_violation', 'A production key needs a gateway review and a client review.');
      }
    }
    const active = await tx.selectFrom('ing_key').select(sql<number>`count(*)::int`.as('n'))
      .where('client_id', '=', clientId).where('status', '=', 'active').executeTakeFirstOrThrow();
    if (active.n >= 2) throw new ApiError('conflict', 'This client already has two active keys. Revoke one first.');
    await tx.insertInto('ing_key').values({ id: keyId, client_id: clientId }).execute();
    await audit({ actorKind: 'user', actorId, action: 'ing.key.issue', targetKind: 'ing_key', targetId: keyId, details: { clientId } }, tx);
    return deriveSecret(master, client.environment, client.module, clientId, keyId);
  });
  return { keyId, secret };
}

/** ING-29: takes effect on the next request; cannot be undone. Idempotent. */
export async function revokeKey(actorId: string, clientId: string, keyId: string) {
  const r = await getDb().updateTable('ing_key').set({ status: 'revoked', revoked_at: new Date() })
    .where('id', '=', keyId).where('client_id', '=', clientId).where('status', '=', 'active').executeTakeFirst();
  if (r.numUpdatedRows) {
    await audit({ actorKind: 'user', actorId, action: 'ing.key.revoke', targetKind: 'ing_key', targetId: keyId, details: { clientId } });
  }
}

export async function addReview(actorId: string, input: { kind: 'gateway' | 'client'; clientId?: string | null; notes: string }) {
  if (input.kind === 'client' && !input.clientId) throw new ApiError('validation', 'A client review needs a client.', { field: 'clientId' });
  const id = newId();
  await getDb().insertInto('ing_review').values({
    id, kind: input.kind, client_id: input.kind === 'client' ? input.clientId! : null, recorded_by: actorId, notes: input.notes,
  }).execute();
  await audit({ actorKind: 'user', actorId, action: 'ing.review.add', targetKind: 'ing_review', targetId: id, details: { kind: input.kind } });
  return { id };
}

/** ING-35: module-wide or per-client pause, with a reason. */
export async function setPause(actorId: string, input: { module?: string; clientId?: string; paused: boolean; reason?: string }) {
  const now = input.paused ? new Date() : null;
  const reason = input.paused ? (input.reason ?? null) : null;
  if (input.clientId) {
    const r = await getDb().updateTable('ing_client').set({ paused_at: now, pause_reason: reason })
      .where('id', '=', input.clientId).executeTakeFirst();
    if (!r.numUpdatedRows) throw new ApiError('not_found', 'Not found.');
  } else if (input.module) {
    await getDb().insertInto('ing_module_setting').values({ module: input.module, paused_at: now, pause_reason: reason })
      .onConflict((oc) => oc.column('module').doUpdateSet({ paused_at: now, pause_reason: reason })).execute();
  } else {
    throw new ApiError('validation', 'Give a module or a client.', { field: 'module' });
  }
  await audit({
    actorKind: 'user', actorId, action: input.paused ? 'ing.pause' : 'ing.resume',
    targetKind: input.clientId ? 'ing_client' : 'module', targetId: input.clientId ?? input.module,
  });
}
