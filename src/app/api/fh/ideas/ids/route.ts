// POST fh/ideas/ids: every matching id, capped at 5,000 (FH-151).
import { z } from 'zod';
import { ViewSpecSchema } from '@/modules/fh/columns';
import { requireMember } from '@/modules/fh/access';
import { matchingIds } from '@/modules/fh/query';
import { getDb } from '@/server/db';
import { route } from '@/server/http/route';

const Body = z.strictObject({ viewSpec: ViewSpecSchema });

export const POST = route({ route: 'POST /api/fh/ideas/ids', auth: 'required', body: Body }, async ({ principal, body }) => {
  requireMember(principal);
  return matchingIds(getDb(), body.viewSpec);
});
