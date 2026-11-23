// Deploy step: `pnpm db:migrate`. Prints every migration id it applies (NFR-41).
// Uses the DIRECT (non-pooled) connection string: migrations need session-level transactions.
import { Client } from 'pg';
import { migrate } from '../db/migrate';

async function main() {
  const url = process.env.DATABASE_URL_DIRECT;
  if (!url) throw new Error('DATABASE_URL_DIRECT is not set');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const applied = await migrate(
      { exec: (s) => client.query(s), query: async (s, p) => ({ rows: (await client.query(s, p as unknown[])).rows }) },
      (m) => console.log(m),
    );
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema up to date');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
