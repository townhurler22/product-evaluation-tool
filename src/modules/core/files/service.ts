// Files (ARC-26 to ARC-30, SEC-28, SEC-29). Pattern for owners (ING-25):
//   1. prepareUpload() before the owner's transaction: sniff, strip metadata, upload.
//   2. insertFileRows(tx, …) inside the owner's transaction.
//   3. If that transaction fails, discardUploads(); after an owner delete commits, deleteFiles().
import sharp from 'sharp';
import type { Kysely, Transaction } from 'kysely';
import { getDb, type DB } from '@/server/db';
import { ApiError } from '@/server/http/errors';
import { newId, sha256 } from '../util';
import { getStorage, StorageUnavailable } from './storage';

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';
export const SIGNED_URL_TTL_S = 15 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids that cannot exist are dropped up front rather than reaching SQL as a bad uuid. */
const validIds = (ids: string[]) => [...new Set(ids)].filter((id) => UUID_RE.test(id));

/** ARC-27: decide the type from the bytes, never from what the sender declared. */
export function sniffImage(b: Buffer): ImageType | 'image/gif' | 'image/svg+xml' | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return 'image/gif';
  if (/^\s*(<\?xml|<svg)/i.test(b.toString('utf8', 0, 256))) return 'image/svg+xml';
  return null;
}

/** SEC-28: re-encode in the same format and dimensions. sharp drops EXIF/XMP/GPS unless asked to keep it. */
async function stripMetadata(b: Buffer, type: ImageType): Promise<Buffer> {
  const img = sharp(b, { failOn: 'error' }).rotate(); // apply EXIF orientation before it is dropped
  if (type === 'image/png') return img.png().toBuffer();
  if (type === 'image/jpeg') return img.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  return img.webp({ quality: 90 }).toBuffer();
}

export interface PreparedFile {
  id: string; module: 'fh' | 'jb'; owner_kind: string; owner_id: string; storage_key: string;
  content_type: ImageType; size_bytes: number; sha256: string; original_name: string | null; created_by: string | null;
}

export interface UploadInput {
  module: 'fh' | 'jb';
  ownerKind: string;
  ownerId: string;
  bytes: Buffer;
  /** If given, a mismatch with the sniffed type is 415 file_type_mismatch (ING-20). */
  declaredType?: string;
  originalName?: string | null;
  createdBy: string | null;
  maxBytes: number;
}

export async function prepareUpload(input: UploadInput): Promise<PreparedFile> {
  if (input.bytes.length > input.maxBytes) throw new ApiError('too_large', 'The file is too large.');
  const sniffed = sniffImage(input.bytes);
  if (sniffed !== 'image/png' && sniffed !== 'image/jpeg' && sniffed !== 'image/webp') {
    throw new ApiError('unsupported_type', 'Only PNG, JPEG and WebP images are allowed.', { reason: 'file_type_not_allowed' });
  }
  if (input.declaredType && input.declaredType !== sniffed) {
    throw new ApiError('unsupported_type', 'The file does not match its declared type.', { reason: 'file_type_mismatch' });
  }
  let clean: Buffer;
  try { clean = await stripMetadata(input.bytes, sniffed); } catch {
    throw new ApiError('unsupported_type', 'The image could not be read.', { reason: 'file_type_not_allowed' });
  }
  const id = newId();
  // ARC-26/SEC-28: keys never include user input.
  const key = `${input.module}/${input.ownerKind}/${input.ownerId}/${id}`;
  try {
    await getStorage().put(key, clean, sniffed);
  } catch (e) {
    if (e instanceof StorageUnavailable) throw new ApiError('files_unavailable', 'File storage is unavailable. Try again shortly.');
    throw e;
  }
  return {
    id, module: input.module, owner_kind: input.ownerKind, owner_id: input.ownerId, storage_key: key, content_type: sniffed,
    size_bytes: clean.length, sha256: sha256(clean),
    original_name: input.originalName ? input.originalName.normalize('NFC').slice(0, 200) : null, created_by: input.createdBy,
  };
}

export async function insertFileRows(db: Kysely<DB> | Transaction<DB>, files: PreparedFile[]) {
  if (files.length) await db.insertInto('core_file').values(files).execute();
}

/** After a failed owner transaction: remove uploaded objects; anything left is marked for the sweep. */
export async function discardUploads(files: PreparedFile[]) {
  if (!files.length) return;
  try { await getStorage().remove(files.map((f) => f.storage_key)); } catch {
    await getDb().insertInto('core_file').values(files.map((f) => ({ ...f, deleted_at: new Date() })))
      .onConflict((oc) => oc.column('id').doUpdateSet({ deleted_at: new Date() })).execute();
  }
}

/** ARC-29: call after the owner's rows commit. A storage failure marks rows for the nightly retry. */
export async function deleteFiles(rawIds: string[]): Promise<number> {
  const ids = validIds(rawIds);
  if (!ids.length) return 0;
  const db = getDb();
  const rows = await db.selectFrom('core_file').select(['id', 'storage_key']).where('id', 'in', ids).execute();
  try {
    await getStorage().remove(rows.map((r) => r.storage_key));
    await db.deleteFrom('core_file').where('id', 'in', rows.map((r) => r.id)).execute();
  } catch {
    await db.updateTable('core_file').set({ deleted_at: new Date() }).where('id', 'in', rows.map((r) => r.id)).execute();
  }
  return rows.length;
}

/** Signed URLs for files the caller has already been authorised to reach (ARC-28, SEC-10). */
export async function signFileUrls(rawIds: string[]): Promise<Record<string, { url: string; contentType: string; name: string | null }>> {
  const ids = validIds(rawIds);
  if (!ids.length) return {};
  const rows = await getDb().selectFrom('core_file').select(['id', 'storage_key', 'content_type', 'original_name'])
    .where('id', 'in', ids).where('deleted_at', 'is', null).execute();
  let urls: Record<string, string>;
  try { urls = await getStorage().signUrls(rows.map((r) => r.storage_key), SIGNED_URL_TTL_S); } catch {
    throw new ApiError('files_unavailable', 'File storage is unavailable. Try again shortly.');
  }
  return Object.fromEntries(rows.filter((r) => urls[r.storage_key])
    .map((r) => [r.id, { url: urls[r.storage_key], contentType: r.content_type, name: r.original_name }]));
}

// ── nightly sweep (ARC-29, job core.files.sweep) ────────────────────────────────
type OwnerResolver = (ownerIds: string[]) => Promise<Set<string>>;
const owners = new Map<string, OwnerResolver>();

/** Every owner kind registers how to tell whether its owners still exist. */
export function registerFileOwnerResolver(module: 'fh' | 'jb', ownerKind: string, r: OwnerResolver) {
  owners.set(`${module}/${ownerKind}`, r);
}

export async function sweepFiles(batch = 1000): Promise<{ retried: number; orphaned: number }> {
  const db = getDb();
  const marked = await db.selectFrom('core_file').select('id').where('deleted_at', 'is not', null).limit(batch).execute();
  const retried = marked.length ? await deleteFiles(marked.map((r) => r.id)) : 0;

  let orphaned = 0;
  for (const [kind, resolve] of owners) {
    const [module, ownerKind] = kind.split('/');
    const rows = await db.selectFrom('core_file').select(['id', 'owner_id'])
      .where('module', '=', module as 'fh' | 'jb').where('owner_kind', '=', ownerKind).where('deleted_at', 'is', null)
      .limit(batch).execute();
    if (!rows.length) continue;
    const alive = await resolve([...new Set(rows.map((r) => r.owner_id))]);
    const dead = rows.filter((r) => !alive.has(r.owner_id)).map((r) => r.id);
    orphaned += await deleteFiles(dead);
  }
  return { retried, orphaned };
}
