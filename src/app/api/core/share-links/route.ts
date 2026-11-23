import { z } from 'zod';
import { createShareLink, listShareLinks } from '@/modules/core/share/links';
import { ApiError } from '@/server/http/errors';
import { route } from '@/server/http/route';

const Target = { module: z.enum(['fh', 'jb']), targetKind: z.enum(['forum', 'board']), targetId: z.uuid() };

export const GET = route({ route: 'GET /api/core/share-links', auth: 'required' }, async ({ req, principal }) => {
  const q = z.object(Target).safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) throw new ApiError('validation', q.error.issues[0].message, { field: q.error.issues[0].path.join('.') });
  return { links: await listShareLinks(principal!, q.data.module, q.data.targetKind, q.data.targetId) };
});

const Create = z.strictObject({
  ...Target,
  capabilities: z.array(z.enum(['VIEW', 'SUBMIT', 'VOTE'])).max(3),
  password: z.string().min(8).max(200).nullish(),
  maxUses: z.number().int().min(1).max(1_000_000).nullish(),
  expiresAt: z.iso.datetime().nullish(),
});

export const POST = route({ route: 'POST /api/core/share-links', auth: 'required', body: Create }, async ({ req, principal, body }) => {
  const out = await createShareLink(principal!, body, process.env.APP_ORIGIN ?? new URL(req.url).origin);
  return Response.json(out, { status: 201, headers: { 'Cache-Control': 'no-store' } });
});
