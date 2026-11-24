// The one database handle. Pool settings follow ARC-34: 10 connections, 2 s acquire timeout.
import { Kysely, PostgresDialect, type Dialect } from 'kysely';
import { Pool, types } from 'pg';
import { countingDialect } from './counting-dialect';
import { devPgliteDialect } from './dev-pglite';
import type { DB } from './schema';

// Money (numeric) and bigints travel as strings; dates stay 'YYYY-MM-DD' (§6 conventions).
types.setTypeParser(types.builtins.NUMERIC, (v) => v);
types.setTypeParser(types.builtins.DATE, (v) => v);

let db: Kysely<DB> | null = null;

function createPoolDialect(): Dialect {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new PostgresDialect({
    pool: new Pool({
      connectionString,
      max: Number(process.env.DB_POOL_SIZE ?? 10),
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 30_000,
    }),
  });
}

export function getDb(): Kysely<DB> {
  if (!db && process.env.DATABASE_URL === 'pglite:memory') {
    if (process.env.NODE_ENV === 'production') throw new Error('pglite:memory is for local development only');
    // One in-memory database per dev server process, shared by every route bundle.
    const g = globalThis as { __petDevDb?: Kysely<DB> };
    g.__petDevDb ??= new Kysely<DB>({ dialect: countingDialect(devPgliteDialect()) });
    db = g.__petDevDb;
  }
  if (!db) db = new Kysely<DB>({ dialect: countingDialect(createPoolDialect()) });
  return db;
}

/** Tests swap in a PGlite-backed instance. */
export function setDb(dialect: Dialect): Kysely<DB> {
  db = new Kysely<DB>({ dialect: countingDialect(dialect) });
  return db;
}

export type { DB } from './schema';
