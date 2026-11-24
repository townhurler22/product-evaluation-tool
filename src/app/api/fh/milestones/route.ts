// GET, POST fh/milestones (FH-751).
import { NextResponse } from 'next/server';
import { requireAdmin, requireMember } from '@/modules/fh/access';
import { createMilestone, lookups, MilestoneBody } from '@/modules/fh/taxonomy';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/milestones', auth: 'required' }, async ({ principal }) => {
  requireMember(principal);
  return { milestones: (await lookups(principal)).milestones };
});

export const POST = route({ route: 'POST /api/fh/milestones', auth: 'required', body: MilestoneBody }, async ({ principal, body }) => {
  requireAdmin(principal);
  return NextResponse.json(await createMilestone(principal, body), { status: 201 });
});
