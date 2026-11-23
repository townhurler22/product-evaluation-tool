// Object storage adapters (ARC-26, SEC-28). Private bucket; downloads only via short-lived signed URLs.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface ObjectStorage {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  remove(keys: string[]): Promise<void>;
  /** 15-minute signed URLs (ARC-28), served from the storage origin, never the app's (SEC-29). */
  signUrls(keys: string[], ttlSeconds: number): Promise<Record<string, string>>;
}

export class StorageUnavailable extends Error {}

class SupabaseStorage implements ObjectStorage {
  private readonly client: SupabaseClient;
  constructor(url: string, serviceKey: string, private readonly bucket: string) {
    this.client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  async put(key: string, bytes: Buffer, contentType: string) {
    const { error } = await this.client.storage.from(this.bucket).upload(key, bytes, { contentType, upsert: false });
    if (error) throw new StorageUnavailable(error.message);
  }
  async remove(keys: string[]) {
    if (!keys.length) return;
    const { error } = await this.client.storage.from(this.bucket).remove(keys);
    if (error) throw new StorageUnavailable(error.message);
  }
  async signUrls(keys: string[], ttlSeconds: number) {
    if (!keys.length) return {};
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUrls(keys, ttlSeconds);
    if (error) throw new StorageUnavailable(error.message);
    const out: Record<string, string> = {};
    for (const d of data ?? []) if (d.path && d.signedUrl) out[d.path] = d.signedUrl;
    return out;
  }
}

/** In-memory adapter for tests; `down` simulates an outage (ARC-30). */
export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  down = false;
  failRemove = false;
  async put(key: string, bytes: Buffer, contentType: string) {
    if (this.down) throw new StorageUnavailable('down');
    this.objects.set(key, { bytes, contentType });
  }
  async remove(keys: string[]) {
    if (this.down || this.failRemove) throw new StorageUnavailable('down');
    for (const k of keys) this.objects.delete(k);
  }
  async signUrls(keys: string[], ttl: number) {
    if (this.down) throw new StorageUnavailable('down');
    return Object.fromEntries(keys.map((k) => [k, `https://storage.test/${k}?ttl=${ttl}&sig=x`]));
  }
}

let storage: ObjectStorage | null = null;

export function getStorage(): ObjectStorage {
  if (storage) return storage;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new StorageUnavailable('storage is not configured');
  const s = new SupabaseStorage(url, key, process.env.STORAGE_BUCKET ?? 'files');
  storage = s;
  return s;
}

export function setStorage(s: ObjectStorage) { storage = s; }
