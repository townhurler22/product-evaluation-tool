// Intake route table entry point (ING-04). Its own pipeline: no session, no CSRF rule (ING-09 refuses browsers).
import { NextResponse, type NextRequest } from 'next/server';
import { runIntake } from '@/modules/core/intake/gateway';
import { newContext, runWithContext } from '@/server/context';
import '@/server/intake-registry';
import { STATEMENT_BUDGETS } from '@/server/http/budgets';

type Params = { params: Promise<{ module: string; route: string }> };

export async function POST(req: NextRequest, { params }: Params): Promise<Response> {
  const { module, route } = await params;
  const ctx = newContext(`POST /api/ingest/${module}/v1/:route`);
  return runWithContext(ctx, async () => {
    const a = await runIntake(req, module, route);
    const res = a.body === undefined ? new NextResponse(null, { status: a.status }) : NextResponse.json(a.body, { status: a.status });
    for (const [k, v] of Object.entries(a.headers ?? {})) res.headers.set(k, v);
    res.headers.set('x-request-id', ctx.requestId);
    res.headers.set('x-statement-count', String(ctx.statements));
    const budget = (STATEMENT_BUDGETS as Record<string, number>)[`POST /api/ingest/${module}/v1/${route}`];
    if (budget !== undefined) {
      res.headers.set('x-statement-budget', String(budget));
      if (ctx.statements > budget) console.warn(JSON.stringify({ level: 'warn', msg: 'statement budget exceeded', route: ctx.route, count: ctx.statements, budget }));
    }
    res.headers.set('Cache-Control', 'no-store');
    return res;
  });
}

const notFound = () => NextResponse.json({ code: 'not_found', message: 'Not found.' }, { status: 404 });
export const GET = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
