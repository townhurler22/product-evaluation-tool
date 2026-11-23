// Route wrapper implementing the request lifecycle (SPEC §3.4):
// request id → session/principal (optional) → validate → handle → envelope + Server-Timing.
import { NextResponse, type NextRequest } from 'next/server';
import type { z } from 'zod';
import { newContext, runWithContext, type RequestContext } from '../context';
import { STATEMENT_BUDGETS, type BudgetKey } from './budgets';
import { ApiError, toErrorBody, unauthenticated } from './errors';
import { loadPrincipal, type Principal } from '@/modules/core/auth/principal';
import { readSession } from '@/modules/core/auth/session';

type Auth = 'none' | 'optional' | 'required';

interface RouteOptions<S extends z.ZodType | undefined> {
  route: BudgetKey;
  auth: Auth;
  body?: S;
  maxBodyBytes?: number;
  /** SEC-04 same-origin check on state-changing requests. Only server-to-server routes turn it off. */
  csrf?: boolean;
}

/** SEC-04: Origin must equal ours; without Origin, Sec-Fetch-Site must say same-origin. */
export function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  const expected = process.env.APP_ORIGIN ?? new URL(req.url).origin;
  if (origin) return origin === expected;
  return req.headers.get('sec-fetch-site') === 'same-origin';
}

interface HandlerArgs<S extends z.ZodType | undefined> {
  req: NextRequest;
  ctx: RequestContext;
  principal: Principal | null;
  body: S extends z.ZodType ? z.infer<S> : undefined;
  params: Record<string, string>;
}

export type Handler<S extends z.ZodType | undefined> = (args: HandlerArgs<S>) => Promise<Response | unknown>;

function timingHeader(ctx: RequestContext): string {
  const total = performance.now() - ctx.startedAt;
  const app = Math.max(0, total - ctx.dbMs - ctx.poolMs - ctx.authMs);
  const f = (n: number) => n.toFixed(1);
  return `auth;dur=${f(ctx.authMs)}, db;dur=${f(ctx.dbMs)}, pool;dur=${f(ctx.poolMs)}, app;dur=${f(app)}`;
}

export function route<S extends z.ZodType | undefined = undefined>(opts: RouteOptions<S>, handler: Handler<S>) {
  return async (req: NextRequest, segment?: { params?: Promise<Record<string, string>> }): Promise<Response> => {
    const ctx = newContext(opts.route, req.headers.get('x-request-id') ?? undefined);
    return runWithContext(ctx, async () => {
      let res: Response;
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD' && opts.csrf !== false && !isSameOrigin(req)) {
          throw new ApiError('forbidden', 'Cross-site request refused.');
        }
        // Steps 2–3: session + principal. ≤ 1 round trip on a cache miss, 0 on a hit (ARC-07).
        let principal: Principal | null = null;
        if (opts.auth !== 'none') {
          const t0 = performance.now();
          const session = await readSession(req);
          principal = session ? await loadPrincipal(session) : null;
          ctx.authMs = performance.now() - t0 - ctx.dbMs;
          if (opts.auth === 'required' && !principal) throw unauthenticated();
        }

        // Step 4: validate (400 names the field).
        let body: unknown = undefined;
        if (opts.body) {
          const raw = await req.text();
          if (raw.length > (opts.maxBodyBytes ?? 64 * 1024)) throw new ApiError('too_large', 'Request body is too large.');
          let json: unknown;
          try { json = raw ? JSON.parse(raw) : {}; } catch { throw new ApiError('validation', 'Body must be JSON.'); }
          const parsed = opts.body.safeParse(json);
          if (!parsed.success) {
            const issue = parsed.error.issues[0];
            throw new ApiError('validation', issue.message, { field: issue.path.join('.') });
          }
          body = parsed.data;
        }

        const params = (await segment?.params) ?? {};
        const out = await handler({ req, ctx, principal, params, body: body as HandlerArgs<S>['body'] });
        res = out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
      } catch (err) {
        if (!(err instanceof ApiError)) {
          // ARC-43: log ids and route only, never personal data.
          console.error(JSON.stringify({ level: 'error', requestId: ctx.requestId, route: ctx.route, err: String(err) }));
        }
        const { status, body } = toErrorBody(err, ctx.requestId);
        res = NextResponse.json(body, { status });
      }

      res.headers.set('Server-Timing', timingHeader(ctx));
      res.headers.set('x-request-id', ctx.requestId);
      res.headers.set('x-statement-count', String(ctx.statements));
      const budget = STATEMENT_BUDGETS[opts.route];
      if (ctx.statements > budget) {
        console.warn(JSON.stringify({ level: 'warn', msg: 'statement budget exceeded', route: ctx.route, count: ctx.statements, budget }));
      }
      return res;
    });
  };
}
