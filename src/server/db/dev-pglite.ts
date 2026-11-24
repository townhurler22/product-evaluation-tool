// Local development only: `DATABASE_URL=pglite:memory pnpm dev` runs the app on an in-process PostgreSQL (PGlite)
// with every migration applied and the demo account seeded, so the UI can be exercised without any real database.
// Never used in production (getDb refuses it there).
import type { DatabaseConnection, Dialect, Driver, TransactionSettings } from 'kysely';
import { PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';

export function devPgliteDialect(): Dialect {
  let inner: Driver | null = null;
  const ready = (async () => {
    const [{ PGlite }, { pg_trgm }, { pgliteDialect }, { migrate }, { seedDemo }] = await Promise.all([
      import('@electric-sql/pglite'), import('@electric-sql/pglite/contrib/pg_trgm'), import('./pglite-dialect'),
      import('../../../db/migrate'), import('../../../db/seed'),
    ]);
    const pg = await PGlite.create({ extensions: { pg_trgm } });
    await migrate(pg);
    await seedDemo(pg);
    inner = pgliteDialect(pg).createDriver();
    await inner.init();
  })();
  const driver = async () => { await ready; return inner!; };
  const lazy: Driver = {
    init: async () => { await ready; },
    acquireConnection: async () => (await driver()).acquireConnection(),
    beginTransaction: async (c: DatabaseConnection, s: TransactionSettings) => (await driver()).beginTransaction(c, s),
    commitTransaction: async (c: DatabaseConnection) => (await driver()).commitTransaction(c),
    rollbackTransaction: async (c: DatabaseConnection) => (await driver()).rollbackTransaction(c),
    releaseConnection: async (c: DatabaseConnection) => (await driver()).releaseConnection(c),
    destroy: async () => (await driver()).destroy(),
  };
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => lazy,
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}
