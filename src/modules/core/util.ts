import { createHash, createHmac, randomBytes } from 'node:crypto';
import { v7 } from 'uuid';

export const newId = (): string => v7();

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** 32 random bytes, base64url: share tokens and magic-link tokens. */
export const randomToken = (): string => randomBytes(32).toString('base64url');

export const normaliseEmail = (e: string): string => e.normalize('NFC').trim().toLowerCase();

function secret(): string {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 32) throw new Error('APP_SECRET must be set (≥ 32 chars)');
  return s;
}

/** IP hashed with a salt that rotates daily, so hashes can't be joined across days (ARC-43). */
export function hashIp(ip: string | null | undefined, now = new Date()): string | null {
  if (!ip) return null;
  const day = now.toISOString().slice(0, 10);
  return createHmac('sha256', `${secret()}:${day}`).update(ip).digest('hex').slice(0, 32);
}

export function clientIp(req: Request): string | null {
  return req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}

export { secret as appSecret };
