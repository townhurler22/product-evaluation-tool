// jb/boards/:id/images (JB-1802, JB-1803): V reads signed URLs for ids in view; E uploads (multipart, sniffed, max 5 MB).
import { listImages, MAX_IMAGE_BYTES, uploadImage } from '@/modules/jb/server/images';
import { ApiError } from '@/server/http/errors';
import { route } from '@/server/http/route';

export const GET = route({ route: 'GET /api/jb/boards/:id/images', auth: 'required' }, async ({ req, principal, params }) => {
  const ids = (new URL(req.url).searchParams.get('ids') ?? '').split(',').filter(Boolean);
  return listImages(principal!, params.id, ids);
});

export const POST = route({ route: 'POST /api/jb/boards/:id/images', auth: 'required' }, async ({ req, principal, params }) => {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES + 64 * 1024) throw new ApiError('too_large', 'Images can be at most 5 MB.');
  let form: FormData;
  try { form = await req.formData(); } catch { throw new ApiError('validation', 'Send the image as multipart form data.'); }
  const file = form.get('file');
  const imageId = String(form.get('imageId') ?? '');
  if (!(file instanceof Blob)) throw new ApiError('validation', 'Choose an image.', { field: 'file' });
  const name = file instanceof File ? file.name : null;
  const out = await uploadImage(principal!, params.id, imageId, Buffer.from(await file.arrayBuffer()), name);
  return Response.json(out, { status: 201 });
});
