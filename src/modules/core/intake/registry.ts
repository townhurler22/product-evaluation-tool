// Intake route table (ING-04, ING-32). Modules register routes; a route without a body cap or schema
// cannot register. Feedback Hub registers call-requests and support-submissions in P2.
import type { Transaction } from 'kysely';
import type { z } from 'zod';
import type { DB } from '@/server/db';

export interface IntakeClient {
  clientId: string;
  clientName: string;
  keyId: string;
  module: string;
}

export interface IntakeHandlerArgs<T> {
  tx: Transaction<DB>;
  client: IntakeClient;
  requestKey: string;
  receiptId: string;
  body: T;
}

export interface IntakeRoute<S extends z.ZodType = z.ZodType> {
  bodyCap: number;
  schema: S;
  /** Runs inside the receipt transaction (ING-12). Throw ApiError to refuse; nothing is kept. */
  handler: (args: IntakeHandlerArgs<z.infer<S>>) => Promise<void>;
}

const modules = new Map<string, Map<string, IntakeRoute>>();

export function registerIntakeRoute<S extends z.ZodType>(module: string, name: string, route: IntakeRoute<S>) {
  if (!route.bodyCap || route.bodyCap <= 0) throw new Error(`intake route ${module}/${name} needs a body cap`);
  if (!route.schema) throw new Error(`intake route ${module}/${name} needs a schema`);
  if (name.startsWith('_')) throw new Error('route names starting with _ are reserved');
  let m = modules.get(module);
  if (!m) { m = new Map(); modules.set(module, m); }
  m.set(name, route as unknown as IntakeRoute);
}

export const moduleRoutes = (module: string) => modules.get(module);

/** Largest cap among a module's routes: the read cap before the route is known. */
export const maxBodyCap = (module: string) =>
  Math.max(0, ...[...(modules.get(module)?.values() ?? [])].map((r) => r.bodyCap));

export function clearIntakeRoutesForTests() { modules.clear(); }
