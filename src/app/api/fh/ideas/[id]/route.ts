// GET fh/ideas/:id (summary, §4.6; 410 for a tombstone) and PATCH fh/ideas/:id (FH-303).
import { requireAdmin, requireMember } from '@/modules/fh/access';
import { ideaSummary } from '@/modules/fh/detail';
import { idParam } from '@/modules/fh/http';
import { patchIdea } from '@/modules/fh/ideas';
import { PatchIdeaBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/ideas/:id', auth: 'required' }, async ({ principal, params }) => {
  requireMember(principal);
  return ideaSummary(idParam(params));
});

export const PATCH = route({ route: 'PATCH /api/fh/ideas/:id', auth: 'required', body: PatchIdeaBody }, async ({ principal, params, body }) => {
  requireAdmin(principal);
  return { row: await patchIdea(principal, idParam(params), body) };
});
