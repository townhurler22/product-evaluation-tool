// GET fh/companies?q=&offset=&full=1 (FH-801; without full=1, the idea panel's picker). POST: admin creates (FH-802).
import { requireAdmin, requireMember } from '@/modules/fh/access';
import { offsetParam } from '@/modules/fh/http';
import { createCompany, listCompanies } from '@/modules/fh/people';
import { CreateCompanyBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/companies', auth: 'required' }, async ({ req, principal }) => {
  requireMember(principal);
  const sp = req.nextUrl.searchParams;
  return listCompanies(sp.get('q'), offsetParam(sp.get('offset')), sp.get('full') === '1');
});

export const POST = route({ route: 'POST /api/fh/companies', auth: 'required', body: CreateCompanyBody }, async ({ principal, body }) => {
  requireAdmin(principal);
  return Response.json(await createCompany(principal, body), { status: 201 });
});
