// GET fh/ideas (PERF-11, FH-102) and POST fh/ideas (FH-201, §4.4).
import { NextResponse } from 'next/server';
import { requireMember } from '@/modules/fh/access';
import { specFromQuery } from '@/modules/fh/http';
import { createIdea } from '@/modules/fh/ideas';
import { listIdeas } from '@/modules/fh/query';
import { CreateIdeaBody } from '@/modules/fh/schemas';
import { getDb } from '@/server/db';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/ideas', auth: 'required' }, async ({ req, principal }) => {
  requireMember(principal);
  return listIdeas(getDb(), specFromQuery(req), req.nextUrl.searchParams.get('cursor'));
});

// Any member can create an idea (§7 intro).
export const POST = route({ route: 'POST /api/fh/ideas', auth: 'required', body: CreateIdeaBody }, async ({ principal, body }) => {
  requireMember(principal);
  return NextResponse.json({ row: await createIdea(principal, body) }, { status: 201 });
});
