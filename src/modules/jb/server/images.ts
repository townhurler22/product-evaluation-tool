// Board images (JB-1801 to JB-1803, ARC-27 to ARC-30, SEC-28/29). Board-owned core_file + jb_image rows.
import sharp from 'sharp';
import { discardUploads, insertFileRows, prepareUpload, signFileUrls, type Principal } from '@/modules/core/service';
import { getDb } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { loadBoard, requireEdit } from './access';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const LONG_EDGE = 2560;
const IMAGE_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** JB-1801: over 2,560 px on the long edge → downscaled JPEG at quality 0.9; otherwise kept as is (then stripped of metadata). */
export async function downscaleIfNeeded(bytes: Buffer): Promise<Buffer> {
  let meta: sharp.Metadata;
  try { meta = await sharp(bytes).metadata(); } catch { return bytes; } // the sniffer answers 415 for non-images
  const long = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (long <= LONG_EDGE) return bytes;
  return sharp(bytes).rotate().resize({ width: LONG_EDGE, height: LONG_EDGE, fit: 'inside' }).jpeg({ quality: 90 }).toBuffer();
}

export async function uploadImage(principal: Principal, boardId: string, imageId: string, bytes: Buffer, name: string | null) {
  await requireEdit(principal, boardId);
  if (!IMAGE_ID.test(imageId)) throw new ApiError('validation', 'Bad image id.', { field: 'imageId' });
  if (bytes.length > MAX_IMAGE_BYTES) throw new ApiError('too_large', 'Images can be at most 5 MB.');
  const prepared = await prepareUpload({
    module: 'jb', ownerKind: 'board', ownerId: boardId, bytes: await downscaleIfNeeded(bytes), originalName: name,
    createdBy: principal.userId, maxBytes: MAX_IMAGE_BYTES,
  });
  try {
    await getDb().transaction().execute(async (tx) => {
      await insertFileRows(tx, [prepared]);
      await tx.insertInto('jb_image').values({ board_id: boardId, image_id: imageId, file_id: prepared.id }).execute();
    });
  } catch (e) {
    await discardUploads([prepared]);
    if ((e as { code?: string }).code === '23505') throw new ApiError('conflict', 'An image with this id already exists on the board.');
    throw e;
  }
  return { imageId, fileId: prepared.id, contentType: prepared.content_type };
}

/** Signed URLs for image ids on one board; the caller has already been authorised for that board (SEC-10). */
export async function signBoardImages(boardId: string, imageIds: string[]) {
  const ids = [...new Set(imageIds)].filter((i) => IMAGE_ID.test(i)).slice(0, 200);
  if (!ids.length) return {};
  const rows = await getDb().selectFrom('jb_image').select(['image_id', 'file_id']).where('board_id', '=', boardId).where('image_id', 'in', ids).execute();
  const signed = await signFileUrls(rows.map((r) => r.file_id));
  return Object.fromEntries(rows.filter((r) => signed[r.file_id]).map((r) => [r.image_id, signed[r.file_id].url]));
}

export async function listImages(principal: Principal, boardId: string, imageIds: string[]) {
  await loadBoard(principal, boardId);
  return { urls: await signBoardImages(boardId, imageIds) };
}
