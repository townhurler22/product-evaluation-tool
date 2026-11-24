// Workspace admin console services (ARC-16, §11.2 core/admin/*). Every change writes an audit row.
import { sql } from 'kysely';
import { z } from 'zod';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { forgetPrincipal, type Principal } from './auth/principal';
import { audit } from './audit';
import { clearSettingsCache } from './settings';

export function requireWorkspaceAdmin(p: Principal | null): asserts p is Principal {
  if (!p?.isWorkspaceAdmin) throw new ApiError('forbidden', 'Workspace admins only.');
}

// ── users ──────────────────────────────────────────────────────────────────────
const PAGE = 100;

/** Keyset pagination on (email, id). One statement. */
export async function listUsers(cursor: string | null, q: string | null) {
  let query = getDb().selectFrom('core_user')
    .select(['id', 'email', 'full_name', 'role', 'status', 'created_at']).orderBy('email').orderBy('id').limit(PAGE + 1);
  if (q) query = query.where('email', 'like', `%${q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`);
  if (cursor) query = query.where('email', '>', cursor);
  const rows = await query.execute();
  return { users: rows.slice(0, PAGE), nextCursor: rows.length > PAGE ? rows[PAGE - 1].email : null };
}

export async function updateUser(actor: Principal, id: string, patch: { role?: 'ADMIN' | 'PRODUCT' | 'MEMBER'; status?: 'ACTIVE' | 'DISABLED' }) {
  if (id === actor.userId && (patch.status === 'DISABLED' || (patch.role && patch.role !== 'ADMIN'))) {
    throw new ApiError('rule_violation', 'You cannot remove your own admin access.');
  }
  const user = await getDb().transaction().execute(async (tx) => {
    const before = await tx.selectFrom('core_user').select(['role', 'status']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!before) throw new ApiError('not_found', 'Not found.');
    if (before.role === 'ADMIN' && (patch.role && patch.role !== 'ADMIN' || patch.status === 'DISABLED')) {
      const admins = await tx.selectFrom('core_user').select(sql<number>`count(*)::int`.as('n'))
        .where('role', '=', 'ADMIN').where('status', '=', 'ACTIVE').executeTakeFirstOrThrow();
      if (admins.n <= 1) throw new ApiError('rule_violation', 'The workspace needs at least one active admin.');
    }
    const deactivating = patch.status === 'DISABLED' && before.status !== 'DISABLED';
    const updated = await tx.updateTable('core_user').set({
      ...(patch.role && { role: patch.role }),
      ...(patch.status && { status: patch.status }),
      // SEC-05/ARC-11: deactivation ends every session.
      ...(deactivating && { session_epoch: sql`session_epoch + 1` }),
    }).where('id', '=', id).returning(['id', 'email', 'full_name', 'role', 'status', 'created_at']).executeTakeFirstOrThrow();
    await audit({
      actorKind: 'user', actorId: actor.userId,
      action: patch.status ? 'core.user.status_change' : 'core.user.role_change',
      targetKind: 'user', targetId: id,
      details: { from: before, to: { role: updated.role, status: updated.status } },
    }, tx);
    return updated;
  });
  forgetPrincipal(id); // this instance applies it at once (ARC-12)
  return user;
}

// ── settings ───────────────────────────────────────────────────────────────────
const domain = z.string().trim().toLowerCase().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Enter a bare domain such as example.com');

export const SettingsPatch = z.strictObject({
  'auth.allowed_domains': z.array(domain).max(50),
  'intake.staff_domains': z.array(domain).max(50),
  'intake.public_email_domains': z.array(domain).max(500),
  'intake.internal_company_id': z.uuid().nullable(),
  'release_train.anchor': z.iso.date(),
  'release_train.length_days': z.number().int().min(7).max(90),
  'planning_year.start_month': z.number().int().min(1).max(12),
  currency: z.string().regex(/^[A-Z]{3}$/),
  'forum.default_label': z.string().trim().min(1).max(40),
  'export.include_personal_data': z.boolean(),
}).partial();

export async function getAllSettings() {
  const rows = await getDb().selectFrom('core_setting').select(['key', 'value', 'updated_at']).orderBy('key').execute();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function updateSettings(actor: Principal, patch: z.infer<typeof SettingsPatch>) {
  const entries = Object.entries(patch);
  if (!entries.length) return getAllSettings();
  await getDb().transaction().execute(async (tx) => {
    for (const [key, value] of entries) {
      await tx.insertInto('core_setting').values({ key, value: JSON.stringify(value), updated_by: actor.userId })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_by: actor.userId, updated_at: new Date() }))
        .execute();
    }
    await audit({ actorKind: 'user', actorId: actor.userId, action: 'core.settings.update', details: { keys: entries.map(([k]) => k) } }, tx);
  });
  clearSettingsCache();
  return getAllSettings();
}

// ── audit and jobs ─────────────────────────────────────────────────────────────
export async function listAudit(f: { actorId?: string; action?: string; targetId?: string; before?: string }) {
  let q = getDb().selectFrom('core_audit_log').selectAll().orderBy('created_at', 'desc').orderBy('id', 'desc').limit(PAGE + 1);
  if (f.actorId) q = q.where('actor_id', '=', f.actorId);
  if (f.action) q = q.where('action', 'like', `${f.action.replace(/[%_\\]/g, '\\$&')}%`);
  if (f.targetId) q = q.where('target_id', '=', f.targetId);
  if (f.before) q = q.where('created_at', '<', new Date(f.before));
  const rows = await q.execute();
  return { entries: rows.slice(0, PAGE), nextCursor: rows.length > PAGE ? rows[PAGE - 1].created_at.toISOString() : null };
}

export async function listDeadJobs() {
  return getDb().selectFrom('core_job').select(['id', 'kind', 'attempts', 'last_error', 'created_at', 'finished_at'])
    .where('state', '=', 'dead').orderBy('created_at', 'desc').limit(200).execute();
}

export async function retryJob(actor: Principal, id: string) {
  const r = await getDb().updateTable('core_job')
    .set({ state: 'queued', attempts: 0, run_at: new Date(), last_error: null, finished_at: null })
    .where('id', '=', id).where('state', '=', 'dead').returning(['id', 'kind']).executeTakeFirst();
  if (!r) throw new ApiError('not_found', 'Not found.');
  await audit({ actorKind: 'user', actorId: actor.userId, action: 'core.job.retry', targetKind: 'job', targetId: id, details: { kind: r.kind } });
  return r;
}

// ── intake overview (ING-38) ────────────────────────────────────────────────────
export async function intakeOverview() {
  const db = getDb();
  const [clients, keys, counts, modulePause] = await Promise.all([
    db.selectFrom('ing_client').selectAll().orderBy('name').execute(),
    db.selectFrom('ing_key').select(['id', 'client_id', 'status', 'created_at', 'revoked_at', 'last_used_at']).orderBy('created_at').execute(),
    sql<{ client_id: string; outcome: string; d1: number; d7: number }>`
      SELECT client_id, outcome,
             count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS d1,
             count(*)::int AS d7
      FROM ing_log WHERE created_at > now() - interval '7 days' GROUP BY client_id, outcome`.execute(db),
    db.selectFrom('ing_module_setting').selectAll().execute(),
  ]);
  return {
    modules: modulePause,
    clients: clients.map((c) => ({
      ...c,
      keys: keys.filter((k) => k.client_id === c.id),
      outcomes: counts.rows.filter((r) => r.client_id === c.id).map(({ outcome, d1, d7 }) => ({ outcome, d1, d7 })),
    })),
  };
}

export async function clientLog(clientId: string, before: string | null) {
  let q = getDb().selectFrom('ing_log')
    .select(['id', 'key_id', 'route', 'outcome', 'reason', 'status', 'receipt_id', 'body_bytes', 'latency_ms', 'created_at'])
    .where('client_id', '=', clientId).orderBy('created_at', 'desc').limit(200);
  if (before) q = q.where('created_at', '<', new Date(before));
  return q.execute();
}

// ── Feedback Hub grants (ARC-13, SEC-02): feedback admin and the separate post-delete grant ──
export async function setFhGrant(actor: Principal, userId: string, g: { admin: boolean; canDeletePosts: boolean }) {
  const grant = await getDb().transaction().execute(async (tx) => {
    const user = await tx.selectFrom('core_user').select('id').where('id', '=', userId).executeTakeFirst();
    if (!user) throw new ApiError('not_found', 'Not found.');
    const row = await tx.insertInto('fh_grant')
      .values({ user_id: userId, role: g.admin ? 'ADMIN' : null, can_delete_posts: g.canDeletePosts, granted_by: actor.userId })
      .onConflict((oc) => oc.column('user_id').doUpdateSet({ role: g.admin ? 'ADMIN' : null, can_delete_posts: g.canDeletePosts, granted_by: actor.userId }))
      .returning(['user_id', 'role', 'can_delete_posts']).executeTakeFirstOrThrow();
    await audit({ actorKind: 'user', actorId: actor.userId, action: 'core.user.fh_grant', targetKind: 'user', targetId: userId, details: g }, tx);
    return row;
  });
  forgetPrincipal(userId);
  return { userId: grant.user_id, admin: grant.role === 'ADMIN', canDeletePosts: grant.can_delete_posts };
}
