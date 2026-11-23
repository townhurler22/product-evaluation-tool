// Wraps any Kysely dialect so every statement is counted and timed against the current request.
// Transaction control statements are not counted: budgets are about data statements (PERF-03).
import type {
  DatabaseConnection, Dialect, Driver, QueryResult, TransactionSettings, CompiledQuery,
} from 'kysely';
import { currentContext } from '../context';

const CONTROL = /^\s*(begin|start transaction|commit|rollback|savepoint|release)\b/i;

class CountingConnection implements DatabaseConnection {
  constructor(private readonly inner: DatabaseConnection) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const ctx = currentContext();
    const t0 = performance.now();
    try {
      return await this.inner.executeQuery<R>(query);
    } finally {
      if (ctx) {
        ctx.dbMs += performance.now() - t0;
        if (!CONTROL.test(query.sql)) ctx.statements += 1;
      }
    }
  }

  streamQuery<R>(query: CompiledQuery, chunkSize?: number): AsyncIterableIterator<QueryResult<R>> {
    const ctx = currentContext();
    if (ctx) ctx.statements += 1;
    return this.inner.streamQuery<R>(query, chunkSize ?? 100);
  }
}

class CountingDriver implements Driver {
  private readonly wrapped = new WeakMap<DatabaseConnection, CountingConnection>();
  constructor(private readonly inner: Driver) {}

  init() { return this.inner.init(); }
  destroy() { return this.inner.destroy(); }

  async acquireConnection(): Promise<DatabaseConnection> {
    const ctx = currentContext();
    const t0 = performance.now();
    const conn = await this.inner.acquireConnection();
    if (ctx) ctx.poolMs += performance.now() - t0;
    let w = this.wrapped.get(conn);
    if (!w) { w = new CountingConnection(conn); this.wrapped.set(conn, w); }
    return w;
  }

  private unwrap(c: DatabaseConnection) {
    return (c as unknown as { inner: DatabaseConnection }).inner;
  }
  beginTransaction(c: DatabaseConnection, s: TransactionSettings) { return this.inner.beginTransaction(this.unwrap(c), s); }
  commitTransaction(c: DatabaseConnection) { return this.inner.commitTransaction(this.unwrap(c)); }
  rollbackTransaction(c: DatabaseConnection) { return this.inner.rollbackTransaction(this.unwrap(c)); }
  releaseConnection(c: DatabaseConnection) { return this.inner.releaseConnection(this.unwrap(c)); }
}

export function countingDialect(inner: Dialect): Dialect {
  return {
    createAdapter: () => inner.createAdapter(),
    createDriver: () => new CountingDriver(inner.createDriver()),
    createIntrospector: (db) => inner.createIntrospector(db),
    createQueryCompiler: () => inner.createQueryCompiler(),
  };
}
