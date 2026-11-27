// GET fh/people?q=&offset=&full=1 (FH-811; without full=1, the pickers, which never return emails). POST (FH-812).
import { requireAdmin, requireMember } from '@/modules/fh/access';
import { offsetParam } from '@/modules/fh/http';
import { createPerson, listPeople } from '@/modules/fh/people';
import { CreatePersonBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/people', auth: 'required' }, async ({ req, principal }) => {
  requireMember(principal);
  const sp = req.nextUrl.searchParams;
  const full = sp.get('full') === '1';
  return listPeople(sp.get('q'), offsetParam(sp.get('offset')), full, full && principal.isFeedbackAdmin);
});

export const POST = route({ route: 'POST /api/fh/people', auth: 'required', body: CreatePersonBody }, async ({ principal, body }) => {
  requireAdmin(principal);
  return Response.json(await createPerson(principal, body), { status: 201 });
});
