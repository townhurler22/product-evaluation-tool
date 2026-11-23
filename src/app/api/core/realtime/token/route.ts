// POST core/realtime/token (§11.2): a short-lived token for exactly the channels the caller may join.
import { z } from 'zod';
import { authoriseChannels, mintRealtimeToken } from '@/modules/core/realtime';
import { route } from '@/server/http/route';

const Body = z.strictObject({ channels: z.array(z.string().max(80)).min(1).max(20) });

export const POST = route({ route: 'POST /api/core/realtime/token', auth: 'required', body: Body }, async ({ principal, body }) => {
  const channels = await authoriseChannels(principal!, body.channels);
  const minted = mintRealtimeToken(principal!, channels);
  // ARC-25: without realtime the app still works; the client shows "Live updates paused".
  if (!minted) return { available: false, channels: [] };
  return { available: true, channels, token: minted.token, expiresAt: minted.expiresAt, url: process.env.SUPABASE_URL ?? null };
});
