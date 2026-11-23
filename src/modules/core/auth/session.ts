// Sealed session cookie (ARC-11). Verified and decrypted in memory: no database call.
import { sealData, unsealData } from 'iron-session';
import type { NextRequest } from 'next/server';
import { appSecret } from '../util';

export const SESSION_COOKIE = 'pet_session';
const IDLE_MS = 12 * 60 * 60 * 1000;      // 12-hour idle timeout
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000; // 7-day absolute lifetime
const REFRESH_AFTER_MS = 60 * 60 * 1000;   // re-seal at most hourly to extend the idle window

export interface SessionData {
  userId: string;
  sessionId: string;
  sessionEpoch: number;
  issuedAt: number;
  seenAt: number;
}

export async function sealSession(data: SessionData): Promise<string> {
  return sealData(data, { password: appSecret(), ttl: ABSOLUTE_MS / 1000 });
}

export function isSessionLive(s: SessionData, now = Date.now()): boolean {
  return now - s.issuedAt < ABSOLUTE_MS && now - s.seenAt < IDLE_MS;
}

export function needsRefresh(s: SessionData, now = Date.now()): boolean {
  return now - s.seenAt > REFRESH_AFTER_MS;
}

export async function readSession(req: NextRequest): Promise<SessionData | null> {
  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  try {
    const data = await unsealData<SessionData>(raw, { password: appSecret(), ttl: ABSOLUTE_MS / 1000 });
    return data?.userId && isSessionLive(data) ? data : null;
  } catch {
    return null;
  }
}

export function sessionCookie(value: string) {
  return {
    name: SESSION_COOKIE,
    value,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: ABSOLUTE_MS / 1000,
  };
}

export const clearedSessionCookie = () => ({ ...sessionCookie(''), maxAge: 0 });
