// POST fh/companies/delete (FH-804): 1–100 ids; people detached, insights lose their company, links removed.
import { requireAdmin } from '@/modules/fh/access';
import { deleteCompanies } from '@/modules/fh/people';
import { DeleteCompaniesBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/fh/companies/delete', auth: 'required', body: DeleteCompaniesBody }, async ({ principal, body }) => {
  requireAdmin(principal);
  return deleteCompanies(principal, body.ids);
});
