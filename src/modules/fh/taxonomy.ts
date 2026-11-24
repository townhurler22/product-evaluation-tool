// Features (FH-601–604), Journeys (FH-651–654), themes (FH-701–704) and milestones (FH-751) plus the one-request
// lookups endpoint (§11.2 GET lookups). Writes clear nothing server-side: lookups are read fresh in one statement.
import { sql } from 'kysely';
import { z } from 'zod';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { audit, getSettings, newId, type Principal } from '@/modules/core/service';
import { Uuid } from './columns';
import { publishLookup } from './live';
import { DateStr, optText, reqText } from './schemas';
import type { Db } from './store';

const Colour = z.string().transform((s) => s.trim().toLowerCase()).refine((s) => /^#[0-9a-f]{6}$/.test(s), 'Use a colour like #f59e0b');

function uniqueViolation(e: unknown) {
  const err = e as { code?: string; message?: string };
  return err.code === '23505' || /duplicate key|unique/i.test(String(err.message));
}

// ── lookups ──────────────────────────────────────────────────────────────────
/** Features (with direct counts), Journeys, themes, milestones (with counts) and active owners. One statement. */
export async function lookups(p: Principal) {
  const { rows } = await sql<{ features: unknown; journeys: unknown; themes: unknown; milestones: unknown; owners: unknown }>`
    SELECT
      COALESCE((SELECT json_agg(json_build_object('id', f.id, 'parentId', f.parent_id, 'name', f.name, 'description', f.description,
        'depth', f.depth, 'sortOrder', f.sort_order, 'openCount', COALESCE(d.open_count, 0), 'allCount', COALESCE(d.all_count, 0))
        ORDER BY f.depth, f.sort_order, lower(f.name))
        FROM fh_feature f LEFT JOIN fh_feature_demand d ON d.feature_id = f.id), '[]') AS features,
      COALESCE((SELECT json_agg(json_build_object('id', j.id, 'name', j.name, 'syncedAt', j.synced_at,
        'ideaCount', (SELECT count(*) FROM fh_idea_journey ij JOIN fh_idea i ON i.id = ij.idea_id AND i.merged_into_id IS NULL WHERE ij.journey_id = j.id))
        ORDER BY j.sort_order, j.name_key) FROM fh_journey j), '[]') AS journeys,
      COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'colour', t.colour, 'isSeeded', t.is_seeded,
        'ideaCount', (SELECT count(*) FROM fh_idea_theme it JOIN fh_idea i ON i.id = it.idea_id AND i.merged_into_id IS NULL WHERE it.theme_id = t.id))
        ORDER BY t.name_key) FROM fh_theme t), '[]') AS themes,
      COALESCE((SELECT json_agg(json_build_object('id', m.id, 'name', m.name, 'date', m.date::text, 'colour', m.colour, 'description', m.description,
        'ideaCount', (SELECT count(*) FROM fh_idea i WHERE i.milestone_id = m.id AND i.merged_into_id IS NULL))
        ORDER BY m.date, m.name) FROM fh_milestone m), '[]') AS milestones,
      COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', COALESCE(u.full_name, u.email)) ORDER BY lower(COALESCE(u.full_name, u.email)))
        FROM core_user u WHERE u.status = 'ACTIVE'), '[]') AS owners`.execute(getDb());
  const s = await getSettings();
  return {
    ...rows[0],
    settings: {
      currency: s.currency ?? 'EUR',
      releaseTrain: { anchor: s['release_train.anchor'] ?? '2026-01-05', lengthDays: s['release_train.length_days'] ?? 21 },
      planningYearStartMonth: s['planning_year.start_month'] ?? 5,
    },
    access: { feedbackAdmin: p.isFeedbackAdmin, userId: p.userId },
  };
}

// ── Features ─────────────────────────────────────────────────────────────────
export const FeatureCreateBody = z.strictObject({
  name: reqText(120, 'Name'), parentId: Uuid.nullish(), description: optText(1_000, 'Description').optional(),
});
export const FeaturePatchBody = z.strictObject({
  name: reqText(120, 'Name').optional(),
  description: optText(1_000, 'Description').optional(),
  parentId: Uuid.nullable().optional(),
  /** Position among its siblings after the change, 0-based (reorder, FH-603). */
  position: z.number().int().min(0).max(10_000).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'Change at least one field.', path: ['name'] });

const DEPTH_MSG = 'Features may not nest deeper than 3 levels.';
const DUP_MSG = 'Another Feature with this name already exists here.';

export async function createFeature(p: Principal, b: z.infer<typeof FeatureCreateBody>) {
  const id = newId();
  try {
    await getDb().transaction().execute(async (tx) => {
      let depth = 0;
      if (b.parentId) {
        const parent = await tx.selectFrom('fh_feature').select('depth').where('id', '=', b.parentId).executeTakeFirst();
        if (!parent) throw new ApiError('validation', 'That parent Feature does not exist.', { field: 'parentId' });
        depth = parent.depth + 1;
        if (depth > 2) throw new ApiError('rule_violation', DEPTH_MSG, { field: 'parentId' });
      }
      const order = await sql<{ n: number }>`SELECT COALESCE(max(sort_order) + 1, 0)::int AS n FROM fh_feature
        WHERE parent_id IS NOT DISTINCT FROM ${b.parentId ?? null}::uuid`.execute(tx);
      await tx.insertInto('fh_feature').values({ id, parent_id: b.parentId ?? null, name: b.name, description: b.description ?? null, depth, sort_order: order.rows[0].n }).execute();
      await sql`INSERT INTO fh_feature_closure (ancestor_id, descendant_id, distance)
        SELECT ancestor_id, ${id}::uuid, distance + 1 FROM fh_feature_closure WHERE descendant_id = ${b.parentId ?? null}::uuid
        UNION ALL SELECT ${id}::uuid, ${id}::uuid, 0`.execute(tx);
      await tx.insertInto('fh_feature_demand').values({ feature_id: id }).execute();
    });
  } catch (e) {
    if (uniqueViolation(e)) throw new ApiError('conflict', DUP_MSG, { field: 'name' });
    throw e;
  }
  publishLookup('feature', id);
  return { feature: await featureById(getDb(), id) };
}

async function featureById(db: Db, id: string) {
  const { rows } = await sql`SELECT f.id, f.parent_id AS "parentId", f.name, f.description, f.depth, f.sort_order AS "sortOrder",
    COALESCE(d.open_count, 0) AS "openCount", COALESCE(d.all_count, 0) AS "allCount"
    FROM fh_feature f LEFT JOIN fh_feature_demand d ON d.feature_id = f.id WHERE f.id = ${id}::uuid`.execute(db);
  return rows[0] ?? null;
}

export async function patchFeature(p: Principal, id: string, b: z.infer<typeof FeaturePatchBody>) {
  try {
    await getDb().transaction().execute(async (tx) => {
      const cur = await sql<{ depth: number; parent_id: string | null; height: number }>`
        SELECT f.depth, f.parent_id, (SELECT max(distance) FROM fh_feature_closure WHERE ancestor_id = f.id)::int AS height
        FROM fh_feature f WHERE f.id = ${id}::uuid FOR UPDATE`.execute(tx);
      const f = cur.rows[0];
      if (!f) throw new ApiError('not_found', 'Not found.');
      let parentId = f.parent_id;
      if (b.parentId !== undefined && b.parentId !== f.parent_id) {
        parentId = b.parentId;
        let newDepth = 0;
        if (parentId) {
          const np = await sql<{ depth: number; inside: boolean }>`
            SELECT depth, EXISTS (SELECT 1 FROM fh_feature_closure WHERE ancestor_id = ${id}::uuid AND descendant_id = ${parentId}::uuid) AS inside
            FROM fh_feature WHERE id = ${parentId}::uuid`.execute(tx);
          if (!np.rows[0]) throw new ApiError('validation', 'That parent Feature does not exist.', { field: 'parentId' });
          if (np.rows[0].inside) throw new ApiError('rule_violation', 'A Feature cannot move under itself.', { field: 'parentId' });
          newDepth = np.rows[0].depth + 1;
        }
        if (newDepth + (f.height ?? 0) > 2) throw new ApiError('rule_violation', DEPTH_MSG, { field: 'parentId' });
        const delta = newDepth - f.depth;
        // Move the subtree and rewrite its closure in the same transaction (FH-603).
        await sql`UPDATE fh_feature SET depth = depth + ${delta}, parent_id = CASE WHEN id = ${id}::uuid THEN ${parentId}::uuid ELSE parent_id END
          WHERE id IN (SELECT descendant_id FROM fh_feature_closure WHERE ancestor_id = ${id}::uuid)`.execute(tx);
        await sql`DELETE FROM fh_feature_closure
          WHERE descendant_id IN (SELECT descendant_id FROM fh_feature_closure WHERE ancestor_id = ${id}::uuid)
            AND ancestor_id NOT IN (SELECT descendant_id FROM fh_feature_closure WHERE ancestor_id = ${id}::uuid)`.execute(tx);
        if (parentId) {
          await sql`INSERT INTO fh_feature_closure (ancestor_id, descendant_id, distance)
            SELECT a.ancestor_id, s.descendant_id, a.distance + s.distance + 1
            FROM fh_feature_closure a, fh_feature_closure s WHERE a.descendant_id = ${parentId}::uuid AND s.ancestor_id = ${id}::uuid`.execute(tx);
        }
      }
      if (b.name !== undefined || b.description !== undefined) {
        await tx.updateTable('fh_feature').set({
          ...(b.name !== undefined && { name: b.name }), ...(b.description !== undefined && { description: b.description }),
        }).where('id', '=', id).execute();
      }
      if (b.position !== undefined || b.parentId !== undefined) {
        const sibs = await sql<{ id: string }>`SELECT id::text FROM fh_feature WHERE parent_id IS NOT DISTINCT FROM ${parentId}::uuid AND id <> ${id}::uuid
          ORDER BY sort_order, lower(name)`.execute(tx);
        const order = sibs.rows.map((r) => r.id);
        order.splice(Math.min(b.position ?? order.length, order.length), 0, id);
        await sql`UPDATE fh_feature f SET sort_order = o.n - 1 FROM unnest(${order}::uuid[]) WITH ORDINALITY AS o(id, n)
          WHERE f.id = o.id AND f.sort_order <> o.n - 1`.execute(tx);
      }
    });
  } catch (e) {
    if (uniqueViolation(e)) throw new ApiError('conflict', DUP_MSG, { field: 'name' });
    throw e;
  }
  publishLookup('feature', id);
  return { feature: await featureById(getDb(), id) };
}

/** FH-604: sub-Features are deleted; ideas lose their Feature. Board links are kept (they resolve as gone). */
export async function deleteFeature(p: Principal, id: string) {
  const result = await getDb().transaction().execute(async (tx) => {
    const counts = await sql<{ features: number; ideas: number }>`
      SELECT (SELECT count(*) - 1 FROM fh_feature_closure WHERE ancestor_id = ${id}::uuid)::int AS features,
             (SELECT count(*) FROM fh_idea WHERE merged_into_id IS NULL AND feature_id IN
               (SELECT descendant_id FROM fh_feature_closure WHERE ancestor_id = ${id}::uuid))::int AS ideas`.execute(tx);
    const del = await tx.deleteFrom('fh_feature').where('id', '=', id).executeTakeFirst();
    if (!Number(del.numDeletedRows)) throw new ApiError('not_found', 'Not found.');
    await audit({ actorKind: 'user', actorId: p.userId, action: 'fh.feature.delete', targetKind: 'feature', targetId: id, details: counts.rows[0] }, tx);
    return { subFeaturesDeleted: counts.rows[0].features, ideasDetached: counts.rows[0].ideas };
  });
  publishLookup('feature', id);
  return result;
}

// ── Journeys: no create or rename here (FH-652) ──────────────────────────────
export async function deleteJourney(p: Principal, id: string) {
  const res = await getDb().transaction().execute(async (tx) => {
    const n = await sql<{ n: number }>`SELECT count(*)::int AS n FROM fh_idea_journey WHERE journey_id = ${id}::uuid`.execute(tx);
    const del = await tx.deleteFrom('fh_journey').where('id', '=', id).executeTakeFirst();
    if (!Number(del.numDeletedRows)) throw new ApiError('not_found', 'Not found.');
    await audit({ actorKind: 'user', actorId: p.userId, action: 'fh.journey.delete', targetKind: 'journey', targetId: id }, tx);
    return { membershipsRemoved: n.rows[0].n };
  });
  publishLookup('journey', id);
  return res;
}

// ── themes ───────────────────────────────────────────────────────────────────
export const ThemeBody = z.strictObject({ name: reqText(120, 'Name'), colour: Colour.nullish() });
export const ThemePatchBody = z.strictObject({ name: reqText(120, 'Name').optional(), colour: Colour.nullable().optional() })
  .refine((b) => Object.keys(b).length > 0, { message: 'Change at least one field.', path: ['name'] });

async function themeConflict(name: string, exceptId?: string) {
  const existing = await getDb().selectFrom('fh_theme').select(['id', 'name']).where(sql<boolean>`name_key = lower(btrim(${name}))`)
    .$if(!!exceptId, (q) => q.where('id', '<>', exceptId!)).executeTakeFirst();
  if (existing) throw new ApiError('conflict', `A theme called "${existing.name}" already exists.`, { field: 'name', existingId: existing.id });
}

export async function createTheme(p: Principal, b: z.infer<typeof ThemeBody>) {
  await themeConflict(b.name);
  const id = newId();
  try {
    await getDb().insertInto('fh_theme').values({ id, name: b.name, colour: b.colour ?? null }).execute();
  } catch (e) {
    if (uniqueViolation(e)) throw new ApiError('conflict', 'A theme with this name already exists.', { field: 'name' });
    throw e;
  }
  publishLookup('theme', id);
  return { theme: { id, name: b.name, colour: b.colour ?? null, isSeeded: false, ideaCount: 0 } };
}

export async function patchTheme(p: Principal, id: string, b: z.infer<typeof ThemePatchBody>) {
  if (b.name) await themeConflict(b.name, id);
  const t = await getDb().updateTable('fh_theme')
    .set({ ...(b.name !== undefined && { name: b.name }), ...(b.colour !== undefined && { colour: b.colour }) })
    .where('id', '=', id).returning(['id', 'name', 'colour', 'is_seeded']).executeTakeFirst();
  if (!t) throw new ApiError('not_found', 'Not found.');
  publishLookup('theme', id);
  return { theme: { id: t.id, name: t.name, colour: t.colour, isSeeded: t.is_seeded } };
}

/** FH-702: removes the theme from every idea; seeded themes can be renamed but not deleted. */
export async function deleteTheme(p: Principal, id: string) {
  const res = await getDb().transaction().execute(async (tx) => {
    const t = await sql<{ is_seeded: boolean; n: number }>`SELECT is_seeded, (SELECT count(*) FROM fh_idea_theme WHERE theme_id = t.id)::int AS n
      FROM fh_theme t WHERE id = ${id}::uuid`.execute(tx);
    if (!t.rows[0]) throw new ApiError('not_found', 'Not found.');
    if (t.rows[0].is_seeded) throw new ApiError('rule_violation', 'This theme comes with the app and cannot be deleted. You can rename it.');
    await tx.deleteFrom('fh_theme').where('id', '=', id).execute();
    return { ideasUntagged: t.rows[0].n };
  });
  publishLookup('theme', id);
  return res;
}

// ── milestones ───────────────────────────────────────────────────────────────
export const MilestoneBody = z.strictObject({
  name: reqText(120, 'Name'), date: DateStr, colour: Colour.nullish(), description: optText(1_000, 'Description').optional(),
});
export const MilestonePatchBody = z.strictObject({
  name: reqText(120, 'Name').optional(), date: DateStr.optional(), colour: Colour.nullable().optional(),
  description: optText(1_000, 'Description').optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'Change at least one field.', path: ['name'] });

export async function createMilestone(p: Principal, b: z.infer<typeof MilestoneBody>) {
  const id = newId();
  await getDb().insertInto('fh_milestone').values({ id, name: b.name, date: b.date, colour: b.colour ?? null, description: b.description ?? null }).execute();
  publishLookup('milestone', id);
  return { milestone: { id, name: b.name, date: b.date, colour: b.colour ?? null, description: b.description ?? null, ideaCount: 0 } };
}

export async function patchMilestone(p: Principal, id: string, b: z.infer<typeof MilestonePatchBody>) {
  const m = await getDb().updateTable('fh_milestone').set({
    ...(b.name !== undefined && { name: b.name }), ...(b.date !== undefined && { date: b.date }),
    ...(b.colour !== undefined && { colour: b.colour }), ...(b.description !== undefined && { description: b.description }),
  }).where('id', '=', id).returning(['id', 'name', sql<string>`date::text`.as('date'), 'colour', 'description']).executeTakeFirst();
  if (!m) throw new ApiError('not_found', 'Not found.');
  publishLookup('milestone', id);
  return { milestone: m };
}

export async function deleteMilestone(p: Principal, id: string) {
  const res = await getDb().transaction().execute(async (tx) => {
    const n = await sql<{ n: number }>`SELECT count(*)::int AS n FROM fh_idea WHERE milestone_id = ${id}::uuid AND merged_into_id IS NULL`.execute(tx);
    const del = await tx.deleteFrom('fh_milestone').where('id', '=', id).executeTakeFirst();
    if (!Number(del.numDeletedRows)) throw new ApiError('not_found', 'Not found.');
    return { ideasDetached: n.rows[0].n };
  });
  publishLookup('milestone', id);
  return res;
}

// ── companies and people pickers (read only in P1; management arrives in P2) ──
/** Searchable, paged lists (D-10): never the whole table. One statement. */
export async function searchCompanies(q: string | null, limit = 50) {
  const term = q?.trim() ? `%${q.trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%` : null;
  const { rows } = await sql`SELECT id, name, domain, arr::text AS arr FROM core_company
    WHERE ${term ? sql`(name_key LIKE ${term} OR domain LIKE ${term})` : sql`true`}
    ORDER BY arr DESC NULLS LAST, name LIMIT ${limit}`.execute(getDb());
  return { companies: rows };
}

export async function searchPeople(q: string | null, limit = 50) {
  const term = q?.trim() ? `%${q.trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%` : null;
  const { rows } = await sql`SELECT p.id, COALESCE(p.display_name, 'Anonymous') AS name, p.verified_by AS "verifiedBy", c.name AS "companyName"
    FROM core_person p LEFT JOIN core_company c ON c.id = p.company_id
    WHERE ${term ? sql`(lower(p.display_name) LIKE ${term} OR p.email LIKE ${term})` : sql`true`}
    ORDER BY p.last_seen_at DESC, p.id LIMIT ${limit}`.execute(getDb());
  return { people: rows };
}
