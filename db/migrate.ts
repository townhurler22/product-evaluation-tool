// Forward-only SQL migration runner (NFR-41, NFR-42). Shared by the CLI script and tests.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// When bundled (the local pglite:memory dev server) __dirname is not this folder; fall back to the project root.
export const MIGRATIONS_DIR = existsSync(join(__dirname, 'migrations')) ? join(__dirname, 'migrations') : join(process.cwd(), 'db', 'migrations');

/** Minimal surface both `pg` clients and PGlite satisfy. */
export interface SqlRunner {
  exec(sql: string): Promise<unknown>;
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function listMigrations(): { id: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => ({ id: f.replace(/\.sql$/, ''), sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') }));
}

/** Applies pending migrations, each in its own transaction. Returns the ids applied. */
export async function migrate(db: SqlRunner, log: (msg: string) => void = () => {}): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS core_schema_migration (
    id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ id: string }>('SELECT id FROM core_schema_migration')).rows.map((r) => r.id));
  const applied: string[] = [];
  for (const m of listMigrations()) {
    if (done.has(m.id)) continue;
    log(`applying ${m.id}`);
    await db.exec(`BEGIN; SET LOCAL lock_timeout = '5s';\n${m.sql}\n;INSERT INTO core_schema_migration (id) VALUES ('${m.id}'); COMMIT;`);
    applied.push(m.id);
  }
  return applied;
}
