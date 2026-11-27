// core_setting read through a 60 s per-instance cache (§4.3 lookup cache). One statement on a miss.
import type { Kysely, Transaction } from 'kysely';
import { getDb, type DB } from '@/server/db';

export interface Settings {
  'auth.allowed_domains': string[];
  'intake.staff_domains': string[];
  'intake.public_email_domains': string[];
  'intake.internal_company_id': string | null;
  'export.include_personal_data': boolean;
  'release_train.anchor': string;
  'release_train.length_days': number;
  'planning_year.start_month': number;
  currency: string;
  'forum.default_label': string;
}

const TTL_MS = 60_000;
let cached: { value: Settings; expires: number } | null = null;

/** Pass the open transaction when calling from inside one, so a miss never waits for a second connection. */
export async function getSettings(db: Kysely<DB> | Transaction<DB> = getDb()): Promise<Settings> {
  if (cached && cached.expires > Date.now()) return cached.value;
  const rows = await db.selectFrom('core_setting').select(['key', 'value']).execute();
  const value = Object.fromEntries(rows.map((r) => [r.key, r.value])) as unknown as Settings;
  cached = { value, expires: Date.now() + TTL_MS };
  return value;
}

export function clearSettingsCache() { cached = null; }
