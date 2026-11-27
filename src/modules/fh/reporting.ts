// Reporting (FH-851 to FH-854). Every number comes from the materialised view fh_reporting_mv (§4.11), refreshed
// concurrently every 5 minutes by the fh.reporting.refresh job. The page never recounts.
import { sql } from 'kysely';
import { getDb } from '@/server/db';
import type { Db } from './store';

export const TREND_WEEKS = 26;
export const TOP_FEATURES = 20;

export async function refreshReporting(db: Db = getDb()) {
  await sql`REFRESH MATERIALIZED VIEW CONCURRENTLY fh_reporting_mv`.execute(db);
}

/** ISO week starts (Mondays, YYYY-MM-DD) for the last 26 weeks, oldest first, ending with the current week. */
export function trendWeeks(now = new Date()): string[] {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const out: string[] = [];
  for (let i = TREND_WEEKS - 1; i >= 0; i--) out.push(new Date(d.getTime() - i * 7 * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** GET fh/reporting: tiles, theme trends and demand by Feature with names. One statement. */
export async function reporting(db: Db = getDb()) {
  const { rows } = await sql<{ kind: string; k1: string; k2: string; n: number; amount: string | null; refreshed_at: Date | string; name: string | null; colour: string | null; depth: number | null }>`
    SELECT m.kind, m.k1, m.k2, m.n, m.amount::text AS amount, m.refreshed_at,
           COALESCE(t.name, f.name) AS name, t.colour, f.depth::int AS depth
    FROM fh_reporting_mv m
    LEFT JOIN fh_theme t ON m.kind = 'theme_week' AND t.id::text = m.k1
    LEFT JOIN fh_feature f ON m.kind = 'feature' AND f.id::text = m.k1
    WHERE m.kind <> 'feature' OR m.k1 IN (
      SELECT k1 FROM fh_reporting_mv WHERE kind = 'feature' ORDER BY n DESC, amount DESC NULLS LAST, k1 LIMIT ${TOP_FEATURES})`.execute(db);
  const tile = (k: string) => rows.find((r) => r.kind === 'tile' && r.k1 === k)?.n ?? 0;
  const total = tile('total'), completed = tile('completed');
  const weeks = trendWeeks();
  const themes = new Map<string, { id: string; name: string; colour: string | null; counts: number[] }>();
  for (const r of rows.filter((x) => x.kind === 'theme_week' && x.name)) {
    const i = weeks.indexOf(r.k2);
    if (i < 0) continue; // a week that left the window since the last refresh
    const t = themes.get(r.k1) ?? { id: r.k1, name: r.name!, colour: r.colour, counts: weeks.map(() => 0) };
    t.counts[i] += r.n;
    themes.set(r.k1, t);
  }
  const refreshed = rows[0]?.refreshed_at ?? null;
  return {
    tiles: { total, completed, incomplete: total - completed, dealbreakers: tile('dealbreakers') },
    themeTrends: { weeks, themes: [...themes.values()].sort((a, b) => b.counts.reduce((x, y) => x + y, 0) - a.counts.reduce((x, y) => x + y, 0) || a.name.localeCompare(b.name)) },
    demandByFeature: rows.filter((r) => r.kind === 'feature' && r.name)
      .map((r) => ({ id: r.k1, name: r.name!, depth: r.depth ?? 0, openCount: r.n, arr: r.amount ?? '0.00' }))
      .sort((a, b) => b.openCount - a.openCount || Number(b.arr) - Number(a.arr) || a.name.localeCompare(b.name)),
    refreshedAt: refreshed instanceof Date ? refreshed.toISOString() : refreshed,
  };
}
