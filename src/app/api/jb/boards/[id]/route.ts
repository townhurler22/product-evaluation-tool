// DELETE jb/boards/:id (JB-104): owner or manager; journeys, comments, collaborators and images go with it.
import { deleteBoard } from '@/modules/jb/server/boards';
import { route } from '@/server/http/route';

export const DELETE = route({ route: 'DELETE /api/jb/boards/:id', auth: 'required' }, async ({ principal, params }) => {
  await deleteBoard(principal!, params.id);
  return new Response(null, { status: 204 });
});
