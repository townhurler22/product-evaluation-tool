// Intake request signing (ING-05 to ING-07). Secrets are derived per request, never stored.
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export const EMPTY_BODY_SHA256 = createHash('sha256').update('').digest('hex');
export const TIMESTAMP_SKEW_S = 300;

export type IngestEnvironment = 'staging' | 'production';

/** secret = hex(HKDF-SHA256(master, salt "ingest/v1", info "<env>|<module>|<client>|<key>", 32)) */
export function deriveSecret(master: Buffer, env: IngestEnvironment, module: string, clientId: string, keyId: string): string {
  return Buffer.from(hkdfSync('sha256', master, 'ingest/v1', `${env}|${module}|${clientId}|${keyId}`, 32)).toString('hex');
}

export const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export function canonicalString(timestamp: string, requestKey: string, path: string, bodySha256: string): string {
  return ['1', timestamp, requestKey, 'POST', path, bodySha256].join('\n');
}

/** HMAC key is the secret's 64-char hex form as UTF-8 bytes (ING-05). */
export function sign(secretHex: string, timestamp: string, requestKey: string, path: string, bodySha256: string): string {
  return createHmac('sha256', Buffer.from(secretHex, 'utf8'))
    .update(canonicalString(timestamp, requestKey, path, bodySha256), 'utf8')
    .digest('hex');
}

/** Hash both sides then compare in constant time, so neither length nor content leaks (ING-07). */
export function signaturesMatch(expected: string, given: string): boolean {
  return timingSafeEqual(createHash('sha256').update(expected).digest(), createHash('sha256').update(given).digest());
}

export function timestampFresh(ts: string, nowS = Math.floor(Date.now() / 1000)): boolean {
  if (!/^\d{1,12}$/.test(ts)) return false;
  const n = Number(ts);
  return Number.isSafeInteger(n) && Math.abs(nowS - n) <= TIMESTAMP_SKEW_S;
}

/** Master key from the environment. Null when missing or < 32 bytes: intake answers 503 (ING-06). */
export function masterKey(): Buffer | null {
  const raw = process.env.INGEST_MASTER_KEY;
  if (!raw) return null;
  const buf = Buffer.from(raw, 'utf8');
  return buf.length >= 32 ? buf : null;
}

export function deploymentEnvironment(): IngestEnvironment {
  return process.env.INGEST_ENVIRONMENT === 'production' ? 'production' : 'staging';
}
