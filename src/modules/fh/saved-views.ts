// Saved views (FH-901–904). Config is validated with a versioned schema on write and read defensively (SEC-16).
import { sql } from 'kysely';
import { z } from 'zod';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { newId, type Principal } from '@/modules/core/service';
import { ViewSpecSchema } from './columns';
import { reqText } from './schemas';

export const SavedViewConfig = z.object({
  version: z.literal(1),
  view: ViewSpecSchema.shape.view,
  rail: ViewSpecSchema.shape.rail.optional(),
  filters: ViewSpecSchema.shape.filters.optional(),
  search: z.string().max(200).optional(),
  sort: ViewSpecSchema.shape.sort.optional(),
  columns: z.array(z.string().max(40)).max(60).optional(),
  widths: z.record(z.string().max(40), z.number().int().min(56).max(2000)).optional(),
});
export type SavedViewConfig = z.infer<typeof SavedViewConfig>;

export const SavedViewBody = z.strictObject({ name: reqText(80, 'Name'), isShared: z.boolean().optional(), config: SavedViewConfig });
export const SavedViewPatchBody = z.strictObject({
  name: reqText(80, 'Name').optional(), isShared: z.boolean().optional(), config: SavedViewConfig.optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'Change at least one field.', path: ['name'] });

function readConfig(raw: unknown): SavedViewConfig {
  const parsed = SavedViewConfig.safeParse(raw);
  return parsed.success ? parsed.data : { version: 1, view: 'all' };
}

const shape = (r: { id: string; name: string; owner_id: string | null; is_shared: boolean; config: unknown }) => ({
  id: r.id, name: r.name, ownerId: r.owner_id, isShared: r.is_shared, builtIn: r.owner_id === null, config: readConfig(r.config),
});

/** Built-ins, the caller's own and shared views. One statement. */
export async function listSavedViews(p: Principal) {
  const rows = await getDb().selectFrom('fh_saved_view').select(['id', 'name', 'owner_id', 'is_shared', 'config'])
    .where((eb) => eb.or([eb('owner_id', 'is', null), eb('owner_id', '=', p.userId), eb('is_shared', '=', true)]))
    .orderBy(sql`owner_id IS NOT NULL`).orderBy('sort_order').orderBy('name').limit(500).execute();
  return { views: rows.map(shape) };
}

export async function createSavedView(p: Principal, b: z.infer<typeof SavedViewBody>) {
  if (b.isShared && !p.isFeedbackAdmin) throw new ApiError('forbidden', 'Only feedback admins can share views.');
  const id = newId();
  const row = await getDb().insertInto('fh_saved_view').values({
    id, name: b.name, owner_id: p.userId, is_shared: b.isShared ?? false, config: JSON.stringify(b.config),
  }).returning(['id', 'name', 'owner_id', 'is_shared', 'config']).executeTakeFirstOrThrow();
  return { view: shape(row) };
}

/** Owners manage their own views; admins also manage shared ones; built-ins are fixed (FH-903). */
async function loadForChange(p: Principal, id: string) {
  const v = await getDb().selectFrom('fh_saved_view').select(['owner_id', 'is_shared']).where('id', '=', id).executeTakeFirst();
  if (!v || (v.owner_id !== p.userId && !v.is_shared && v.owner_id !== null)) throw new ApiError('not_found', 'Not found.');
  if (v.owner_id === null) throw new ApiError('rule_violation', 'Built-in views cannot be changed or deleted.');
  if (v.owner_id !== p.userId && !(v.is_shared && p.isFeedbackAdmin)) throw new ApiError('forbidden', 'Only the owner can change this view.');
  return v;
}

export async function patchSavedView(p: Principal, id: string, b: z.infer<typeof SavedViewPatchBody>) {
  await loadForChange(p, id);
  if (b.isShared && !p.isFeedbackAdmin) throw new ApiError('forbidden', 'Only feedback admins can share views.');
  const row = await getDb().updateTable('fh_saved_view').set({
    ...(b.name !== undefined && { name: b.name }), ...(b.isShared !== undefined && { is_shared: b.isShared }),
    ...(b.config !== undefined && { config: JSON.stringify(b.config) }),
  }).where('id', '=', id).returning(['id', 'name', 'owner_id', 'is_shared', 'config']).executeTakeFirstOrThrow();
  return { view: shape(row) };
}

export async function deleteSavedView(p: Principal, id: string) {
  await loadForChange(p, id);
  await getDb().deleteFrom('fh_saved_view').where('id', '=', id).execute();
  return { ok: true };
}
