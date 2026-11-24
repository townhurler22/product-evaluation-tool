// GET fh/companies/:id (FH-805 detail), PATCH (FH-803: name, domain, ARR, aliases; adopt and release by domain).
import { requireAdmin, requireMember } from '@/modules/fh/access';
import { idParam } from '@/modules/fh/http';
import { companyDetail, updateCompany } from '@/modules/fh/people';
import { PatchCompanyBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/fh/companies/:id', auth: 'required' }, async ({ principal, params }) => {
  requireMember(principal);
  return companyDetail(idParam(params), principal.isFeedbackAdmin);
});

export const PATCH = route({ route: 'PATCH /api/fh/companies/:id', auth: 'required', body: PatchCompanyBody }, async ({ principal, params, body }) => {
  requireAdmin(principal);
  return updateCompany(principal, idParam(params), body);
});
