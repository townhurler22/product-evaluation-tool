// `pnpm db:seed --demo` adds the shared demo account to the live database.
// `pnpm db:seed --fixture [--scale 10] --into-throwaway-database` loads 55,000+ synthetic rows: only ever into a
// disposable database. The live database is the owner's permanent record (DECISIONS OD-02).
import { Client } from 'pg';
import { seedDemo, seedFixture } from '../db/seed';

async function main() {
  const args = process.argv.slice(2);
  const url = process.env.DATABASE_URL_DIRECT;
  if (!url) throw new Error('DATABASE_URL_DIRECT is not set');
  if (args.includes('--fixture') && !args.includes('--into-throwaway-database')) {
    throw new Error('Refusing to load synthetic fixture data. Pass --into-throwaway-database only for a disposable database.');
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const db = { exec: (s: string) => client.query(s), query: async (s: string, p?: unknown[]) => ({ rows: (await client.query(s, p)).rows }) };
  try {
    if (args.includes('--demo')) { await seedDemo(db); console.log('demo seed applied'); }
    if (args.includes('--fixture')) {
      const i = args.indexOf('--scale');
      const scale = i >= 0 ? Number(args[i + 1]) : 1;
      const t0 = Date.now();
      console.log('fixture:', await seedFixture(db, scale), `${Date.now() - t0} ms`);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(String(e).replace(/postgres(ql)?:\/\/\S+/g, '<url>')); process.exit(1); });
