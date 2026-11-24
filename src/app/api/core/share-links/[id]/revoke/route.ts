import '@/server/registrations';
import { revokeShareLink } from '@/modules/core/share/links';
import { route } from '@/server/http/route';

export const POST = route({ route: 'POST /api/core/share-links/:id/revoke', auth: 'required' }, async ({ principal, params }) => ({
  link: await revokeShareLink(principal!, params.id),
}));
