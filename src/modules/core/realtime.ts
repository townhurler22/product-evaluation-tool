// Realtime (§3.7) on Supabase Realtime private channels.
// Authorisation: the app checks each requested channel with the same rules as the API, then mints a
// short-lived JWT listing exactly those channels. An RLS policy on realtime.messages (db/supabase/)
// admits a topic only if it is in the token's `channels` claim. Publishing is server-side, after commit.
import { createHmac } from 'node:crypto';
import type { Principal } from './auth/principal';

const TOKEN_TTL_S = 15 * 60;
const MAX_PAYLOAD_BYTES = 8 * 1024; // ARC-24

type ChannelRule = (principal: Principal, id: string | null) => Promise<boolean>;
const rules = new Map<string, ChannelRule>();

/** Modules register who may join their channels, e.g. 'fh.workspace' or 'jb.board' (id from 'jb.board.<id>'). */
export function registerChannelRule(prefix: string, rule: ChannelRule) { rules.set(prefix, rule); }

// Core-level channels every active member may join.
registerChannelRule('fh.workspace', async () => true);
registerChannelRule('jb.workspace', async () => true);

const CHANNEL_RE = /^(fh|jb)\.[a-z]+(\.[A-Za-z0-9_-]{1,64})?$/;

function splitChannel(ch: string): { prefix: string; id: string | null } {
  const parts = ch.split('.');
  return parts.length === 3 ? { prefix: `${parts[0]}.${parts[1]}`, id: parts[2] } : { prefix: ch, id: null };
}

/** Returns the channels the principal may join; unknown or refused channels are left out. */
export async function authoriseChannels(principal: Principal, channels: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const ch of new Set(channels)) {
    if (!CHANNEL_RE.test(ch)) continue;
    const { prefix, id } = splitChannel(ch);
    const rule = rules.get(prefix);
    if (rule && (await rule(principal, id))) out.push(ch);
  }
  return out;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** HS256 JWT for Supabase Realtime, signed with the project's JWT secret. */
export function mintRealtimeToken(principal: Principal, channels: string[], now = Math.floor(Date.now() / 1000)) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return null;
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    sub: principal.userId, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + TOKEN_TTL_S, channels,
  }));
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return { token: `${header}.${payload}.${sig}`, expiresAt: now + TOKEN_TTL_S };
}

/**
 * Best-effort publish after commit (ARC-22). Payloads over 8 KB must be replaced by a notice that
 * tells clients to pull (ARC-24); this function refuses them rather than silently truncating.
 */
export async function publish(channel: string, event: string, payload: Record<string, unknown>): Promise<boolean> {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) {
    console.error(JSON.stringify({ level: 'error', msg: 'realtime payload over 8 KB; publish a notice instead', channel, event }));
    return false;
  }
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return false;
  try {
    const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ topic: channel, event, payload, private: true }] }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return true;
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'realtime publish failed', channel, event, err: String(e) }));
    return false;
  }
}

/**
 * Several events on one channel in a single broadcast request (bulk writes publish one `idea.upserted` per row).
 * Each payload must be under 8 KB; oversized ones are dropped and logged so the caller can send a notice instead.
 */
export async function publishMany(channel: string, event: string, payloads: Record<string, unknown>[]): Promise<boolean> {
  const ok = payloads.filter((p) => Buffer.byteLength(JSON.stringify(p)) <= MAX_PAYLOAD_BYTES);
  if (ok.length < payloads.length) {
    console.error(JSON.stringify({ level: 'error', msg: 'realtime payload over 8 KB dropped', channel, event, dropped: payloads.length - ok.length }));
  }
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !ok.length) return false;
  try {
    const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: ok.map((payload) => ({ topic: channel, event, payload, private: true })) }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return true;
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'realtime publish failed', channel, event, err: String(e) }));
    return false;
  }
}
