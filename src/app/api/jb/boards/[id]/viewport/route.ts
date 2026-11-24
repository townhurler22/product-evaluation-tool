// PATCH jb/boards/:id/viewport (JB-106): editors; not an op; last writer wins; never moves updated_at.
import { z } from 'zod';
import { saveViewport } from '@/modules/jb/server/boards';
import { route } from '@/server/http/route';

const Body = z.strictObject({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.05).max(8) });

export const PATCH = route({ route: 'PATCH /api/jb/boards/:id/viewport', auth: 'required', body: Body }, async ({ principal, params, body }) => {
  await saveViewport(principal!, params.id, body);
  return new Response(null, { status: 204 });
});
