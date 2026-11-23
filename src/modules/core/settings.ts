// core_setting read through a 60 s per-instance cache (§4.3 lookup cache). One statement on a miss.
import { getDb } from '@/server/db';

export interface Settings {
  'auth.allowed_domains': string[];
  'intake.staff_domains': string[];
  'release_train.anchor': string;
  'release_train.length_days': number;
  'planning_year.start_month': number;
  currency: string;
  'forum.default_label': string;
}

const TTL_MS = 60_000;
let cached: { value: Settings; expires: number } | null = null;

export async function getSettings(): Promise<Settings> {
  if (cached && cached.expires > Date.now()) return cached.value;
  const rows = await getDb().selectFrom('core_setting').select(['key', 'value']).execute();
  const value = Object.fromEntries(rows.map((r) => [r.key, r.value])) as unknown as Settings;
  cached = { value, expires: Date.now() + TTL_MS };
  return value;
}

export function clearSettingsCache() { cached = null; }
