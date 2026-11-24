// GET, POST fh/themes (FH-701).
import { NextResponse } from 'next/server';
import { requireAdmin, requireMember } from '@/modules/fh/access';
import { createTheme, lookups, ThemeBody } from '@/modules/fh/taxonomy';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/themes', auth: 'required' }, async ({ principal }) => {
  requireMember(principal);
  return { themes: (await lookups(principal)).themes };
});

export const POST = route({ route: 'POST /api/fh/themes', auth: 'required', body: ThemeBody }, async ({ principal, body }) => {
  requireAdmin(principal);
  return NextResponse.json(await createTheme(principal, body), { status: 201 });
});
