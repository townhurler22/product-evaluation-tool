// GET, POST fh/features (FH-601, FH-602).
import { NextResponse } from 'next/server';
import { requireAdmin, requireMember } from '@/modules/fh/access';
import { createFeature, FeatureCreateBody, lookups } from '@/modules/fh/taxonomy';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/features', auth: 'required' }, async ({ principal }) => {
  requireMember(principal);
  return { features: (await lookups(principal)).features };
});

export const POST = route({ route: 'POST /api/fh/features', auth: 'required', body: FeatureCreateBody }, async ({ principal, body }) => {
  requireAdmin(principal);
  return NextResponse.json(await createFeature(principal, body), { status: 201 });
});
