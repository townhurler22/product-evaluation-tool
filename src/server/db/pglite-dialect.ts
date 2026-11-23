// Kysely dialect over PGlite (in-process PostgreSQL). Used by integration tests (DECISIONS).
// PGlite has one connection, so connections are handed out one at a time.
import {
  CompiledQuery, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler,
  type DatabaseConnection, type Dialect, type Driver, type QueryResult,
} from 'kysely';
import type { PGlite } from '@electric-sql/pglite';

class PGliteConnection implements DatabaseConnection {
  constructor(private readonly pg: PGlite) {}
  async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
    const res = await this.pg.query<R>(q.sql, q.parameters as unknown[]);
    return {
      rows: res.rows,
      numAffectedRows: res.affectedRows === undefined ? undefined : BigInt(res.affectedRows),
    };
  }
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streamQuery is not supported on PGlite');
  }
}

class PGliteDriver implements Driver {
  private queue: Promise<void> = Promise.resolve();
  private release: (() => void) | null = null;
  private readonly conn: PGliteConnection;
  constructor(private readonly pg: PGlite) { this.conn = new PGliteConnection(pg); }

  async init() {}
  async acquireConnection() {
    const prev = this.queue;
    let done!: () => void;
    this.queue = new Promise<void>((r) => (done = r));
    await prev;
    this.release = done;
    return this.conn;
  }
  async beginTransaction(c: DatabaseConnection) { await c.executeQuery(CompiledQuery.raw('BEGIN')); }
  async commitTransaction(c: DatabaseConnection) { await c.executeQuery(CompiledQuery.raw('COMMIT')); }
  async rollbackTransaction(c: DatabaseConnection) { await c.executeQuery(CompiledQuery.raw('ROLLBACK')); }
  async releaseConnection() { this.release?.(); this.release = null; }
  async destroy() {}
}

export function pgliteDialect(pg: PGlite): Dialect {
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new PGliteDriver(pg),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}
