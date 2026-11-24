// GET, POST fh/saved-views (FH-901, FH-902).
import { NextResponse } from 'next/server';
import { requireMember } from '@/modules/fh/access';
import { createSavedView, listSavedViews, SavedViewBody } from '@/modules/fh/saved-views';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/saved-views', auth: 'required' }, async ({ principal }) => {
  requireMember(principal);
  return listSavedViews(principal);
});

export const POST = route({ route: 'POST /api/fh/saved-views', auth: 'required', body: SavedViewBody }, async ({ principal, body }) => {
  requireMember(principal);
  return NextResponse.json(await createSavedView(principal, body), { status: 201 });
});
