// POST share/<token>/fh/posts (FH-1211 to FH-1213): multipart {title, details?, email?, displayName?} + ≤ 3 images.
// Screenshots are stored before the rows and removed if the transaction fails. SUBMIT.
import '@/server/registrations';
import { shareRoute, shareWrongMethod } from '@/modules/core/share/pipeline';
import { newId } from '@/modules/core/service';
import { POST_IMAGES_MAX } from '@/modules/fh/forum-domain';
import { cleanPostInput, jsonWithCookie, preparePostImages, submitPost, SUBMIT_LIMITS } from '@/modules/fh/forum-public';
import { ApiError } from '@/server/http/errors';

/** Three 2 MB screenshots plus text, as multipart. */
const MAX_BODY = 7 * 1024 * 1024;

export const POST = shareRoute({ module: 'fh', capability: 'SUBMIT', identity: true, limits: SUBMIT_LIMITS, route: 'POST /api/share/:token/fh/posts' }, async ({ req, share }) => {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) throw new ApiError('too_large', 'The post is too large.');
  let form: FormData;
  try { form = await req.formData(); } catch { throw new ApiError('validation', 'Send the post as a form.'); }
  const text = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v : null; };
  const input = cleanPostInput({ title: text('title'), details: text('details'), email: text('email'), displayName: text('displayName') });
  const images = form.getAll('images').filter((f): f is File => typeof f !== 'string' && f.size > 0);
  if (images.length > POST_IMAGES_MAX) throw new ApiError('validation', `Attach at most ${POST_IMAGES_MAX} screenshots.`, { field: 'images' });
  const postId = newId();
  const files = await preparePostImages(postId, await Promise.all(images.map(async (f) => ({ bytes: Buffer.from(await f.arrayBuffer()), name: f.name || null }))));
  const out = await submitPost(share, input, postId, files);
  return jsonWithCookie({ post: out.post }, out.setCookie, 201);
});

export const GET = shareWrongMethod, PUT = shareWrongMethod, PATCH = shareWrongMethod, DELETE = shareWrongMethod, OPTIONS = shareWrongMethod;
