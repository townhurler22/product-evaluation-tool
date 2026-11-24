// PUT fh/ideas/:id/companies: replace the whole set (≤ 100; FH-502, FH-703).
import { requireAdmin } from '@/modules/fh/access';
import { idParam } from '@/modules/fh/http';
import { replaceSet } from '@/modules/fh/ideas';
import { SetBody } from '@/modules/fh/schemas';
import { route } from '@/server/http/route';

const Body = SetBody(100);

export const PUT = route({ route: 'PUT /api/fh/ideas/:id/companies', auth: 'required', body: Body }, async ({ principal, params, body }) => {
  requireAdmin(principal);
  return replaceSet(principal, idParam(params), 'companies', body.ids, body.baseVersion);
});
