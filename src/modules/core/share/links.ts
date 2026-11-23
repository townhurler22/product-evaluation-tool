// Share link management (§11.2 core/share-links). The owning module decides who may manage a target.
import { hash as argonHash } from '@node-rs/argon2';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import type { Principal } from '../auth/principal';
import { audit } from '../audit';
import { newId, randomToken, sha256 } from '../util';
import type { Capability, ShareModule } from './pipeline';

/** SEC-24: Argon2id, ≥ 19 MiB, 2 iterations, parallelism 1. */
export const hashSharePassword = (pw: string) => argonHash(pw, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });

type ManagePolicy = (principal: Principal, targetId: string) => Promise<boolean>;
const policies = new Map<string, ManagePolicy>();

/** Forum links need a feedback admin; board links need E judged with workspace edit off (§11.2). */
export function registerShareManagePolicy(module: ShareModule, targetKind: 'forum' | 'board', p: ManagePolicy) {
  policies.set(`${module}:${targetKind}`, p);
}

async function assertCanManage(principal: Principal, module: ShareModule, targetKind: 'forum' | 'board', targetId: string) {
  const policy = policies.get(`${module}:${targetKind}`);
  if (!policy || !(await policy(principal, targetId))) throw new ApiError('not_found', 'Not found.');
}

export interface CreateShareLink {
  module: ShareModule;
  targetKind: 'forum' | 'board';
  targetId: string;
  capabilities: Capability[];
  password?: string | null;
  maxUses?: number | null;
  expiresAt?: string | null;
}

const publicShape = (r: {
  id: string; module: string; target_kind: string; target_id: string; capabilities: string[]; password_hash: string | null;
  expires_at: Date | null; max_uses: number | null; use_count: number; revoked_at: Date | null; created_at: Date;
}) => ({
  id: r.id, module: r.module, targetKind: r.target_kind, targetId: r.target_id, capabilities: r.capabilities,
  hasPassword: Boolean(r.password_hash), expiresAt: r.expires_at, maxUses: r.max_uses, useCount: r.use_count,
  revokedAt: r.revoked_at, createdAt: r.created_at,
});

/** Returns the URL exactly once (OD-04: only the hash is stored). */
export async function createShareLink(principal: Principal, input: CreateShareLink, origin: string) {
  await assertCanManage(principal, input.module, input.targetKind, input.targetId);
  const caps = Array.from(new Set<Capability>(['VIEW', ...input.capabilities]));
  if (input.targetKind === 'board' && caps.some((c) => c !== 'VIEW')) {
    throw new ApiError('rule_violation', 'Board links can only grant viewing.'); // SEC-09
  }
  const token = randomToken();
  const id = newId();
  const row = await getDb().insertInto('core_share_link').values({
    id, token_hash: sha256(token), module: input.module, target_kind: input.targetKind, target_id: input.targetId,
    capabilities: caps, password_hash: input.password ? await hashSharePassword(input.password) : null,
    max_uses: input.maxUses ?? null, expires_at: input.expiresAt ?? null, created_by: principal.userId,
  }).returningAll().executeTakeFirstOrThrow();
  await audit({ actorKind: 'user', actorId: principal.userId, action: 'core.share_link.create', targetKind: 'share_link', targetId: id,
    details: { module: input.module, targetKind: input.targetKind, targetId: input.targetId, capabilities: caps } });
  const path = input.targetKind === 'forum' ? 'f' : 'b';
  return { link: publicShape(row), url: `${origin}/${path}/${token}` };
}

export async function listShareLinks(principal: Principal, module: ShareModule, targetKind: 'forum' | 'board', targetId: string) {
  await assertCanManage(principal, module, targetKind, targetId);
  const rows = await getDb().selectFrom('core_share_link').selectAll()
    .where('module', '=', module).where('target_kind', '=', targetKind).where('target_id', '=', targetId)
    .orderBy('created_at', 'desc').execute();
  return rows.map(publicShape);
}

async function loadForManage(principal: Principal, id: string) {
  const row = await getDb().selectFrom('core_share_link').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw new ApiError('not_found', 'Not found.');
  await assertCanManage(principal, row.module, row.target_kind, row.target_id);
  return row;
}

/** Idempotent (§11.2). */
export async function revokeShareLink(principal: Principal, id: string) {
  const row = await loadForManage(principal, id);
  if (row.revoked_at) return publicShape(row);
  const updated = await getDb().updateTable('core_share_link').set({ revoked_at: new Date() })
    .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  await audit({ actorKind: 'user', actorId: principal.userId, action: 'core.share_link.revoke', targetKind: 'share_link', targetId: id });
  return publicShape(updated);
}

export async function setShareLinkPassword(principal: Principal, id: string, password: string | null) {
  await loadForManage(principal, id);
  const updated = await getDb().updateTable('core_share_link')
    .set({ password_hash: password ? await hashSharePassword(password) : null })
    .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  await audit({ actorKind: 'user', actorId: principal.userId, action: 'core.share_link.password', targetKind: 'share_link', targetId: id,
    details: { cleared: !password } });
  return publicShape(updated);
}
