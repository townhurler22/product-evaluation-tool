// GET fh/ideas/:id/images (FH-218): intake screenshots as signed URLs, loaded only when the section is expanded.
import { requireMember } from '@/modules/fh/access';
import { ideaImages } from '@/modules/fh/detail';
import { idParam } from '@/modules/fh/http';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/ideas/:id/images', auth: 'required' }, async ({ principal, params }) => {
  requireMember(principal);
  return ideaImages(idParam(params));
});
