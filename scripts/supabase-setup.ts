// `pnpm supabase:setup` — applies db/supabase/setup.sql (bucket, realtime policies, RLS lock-down, cron).
// Needs DATABASE_URL_DIRECT, APP_URL (the deployed origin) and CRON_SECRET. Safe to re-run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function main() {
  const { DATABASE_URL_DIRECT: url, APP_URL: appUrl, CRON_SECRET: cron } = process.env;
  if (!url || !appUrl || !cron) throw new Error('Set DATABASE_URL_DIRECT, APP_URL and CRON_SECRET');
  if (!/^https:\/\/[^/]+$/.test(appUrl)) throw new Error('APP_URL must be an https origin with no path');
  let sql = readFileSync(join(__dirname, '..', 'db', 'supabase', 'setup.sql'), 'utf8');
  sql = sql.replaceAll(":'app_url'", quote(appUrl)).replaceAll(":'cron_secret'", quote(cron));

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    // cron.schedule with an existing name replaces the job, so re-running is safe.
    await client.query(sql);
    const jobs = await client.query<{ jobname: string; schedule: string }>(
      `SELECT jobname, schedule FROM cron.job WHERE jobname LIKE 'pet-%' ORDER BY jobname`);
    console.log('supabase setup applied. cron jobs:', jobs.rows.map((j) => `${j.jobname} (${j.schedule})`).join(', '));
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(String(e).replace(/postgres(ql)?:\/\/\S+/g, '<url>')); process.exit(1); });
