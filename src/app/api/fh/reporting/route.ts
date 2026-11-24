// GET fh/reporting (FH-851–854): tiles, theme trends, demand by Feature and refreshedAt, from fh_reporting_mv.
// pg_cron enqueues the refresh every 5 minutes; if the view is older than that (cron missing or behind), the read
// also enqueues one (debounced) and drains it after the response. The page shows "Updated N minutes ago".
import { requireMember } from '@/modules/fh/access';
import { drainSoon } from '@/modules/fh/live';
import { reporting } from '@/modules/fh/reporting';
import '@/modules/fh/jobs'; // registers fh.reporting.refresh for the after-response drain
import { enqueue } from '@/modules/core/service';
import { route } from '@/server/http/route';

const STALE_MS = 5 * 60_000;

export const GET = route({ route: 'GET /api/fh/reporting', auth: 'required' }, async ({ principal }) => {
  requireMember(principal);
  const out = await reporting();
  if (!out.refreshedAt || Date.now() - Date.parse(out.refreshedAt) > STALE_MS) {
    await enqueue('fh.reporting.refresh', {}, { dedupeKey: 'fh.reporting.refresh' });
    drainSoon();
  }
  return out;
});
