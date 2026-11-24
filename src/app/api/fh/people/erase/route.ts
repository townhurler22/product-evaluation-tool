// POST fh/people/erase (FH-815, SEC-20): {ids[1..100], confirm: "ERASE"} → {erased, postsRecounted, failed[]}.
import { requireAdmin } from '@/modules/fh/access';
import { erasureResponse } from '@/modules/fh/people';
import { EraseBody } from '@/modules/fh/schemas';
import { runErasure } from '@/modules/core/service';
import { route } from '@/server/http/route';
import '@/server/registrations';

export const POST = route({ route: 'POST /api/fh/people/erase', auth: 'required', body: EraseBody }, async ({ principal, body }) => {
  requireAdmin(principal);
  return erasureResponse(await runErasure({ kind: 'user', id: principal.userId }, body.ids));
});
