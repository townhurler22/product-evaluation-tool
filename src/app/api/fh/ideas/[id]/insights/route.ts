// POST fh/ideas/:id/insights (FH-501): a manual insight; the new roll-up comes back in the row (FH-224).
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/modules/fh/access';
import { idParam } from '@/modules/fh/http';
import { addInsight } from '@/modules/fh/ideas';
import { InsightBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/fh/ideas/:id/insights', auth: 'required', body: InsightBody }, async ({ principal, params, body }) => {
  requireAdmin(principal);
  const { insightId, row } = await addInsight(principal, idParam(params), body);
  return NextResponse.json({ insight: { id: insightId }, row }, { status: 201 });
});
