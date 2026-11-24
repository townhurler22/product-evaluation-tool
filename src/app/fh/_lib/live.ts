'use client';

// Live updates on fh.workspace (§3.7). The token endpoint may return no token (realtime not configured); then the
// app polls instead and shows "Live updates paused" (ARC-25). Supabase's client loads only when a token exists.
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

export type LiveEvent =
  | { event: 'idea.upserted'; payload: { row: import('@/modules/fh/rows').IdeaRow } }
  | { event: 'idea.removed'; payload: { id: string; mergedIntoId?: string } }
  | { event: 'lookup.changed'; payload: { kind: string; id: string } }
  | { event: 'idea.detail.changed'; payload: { ideaId: string; sections: string[] } };

interface TokenResponse { available: boolean; channels: string[]; token?: string; url?: string | null }

/** Subscribes to channels; returns whether live delivery is working. Callers poll while it is false. */
export function useLiveChannels(channels: string[], onEvent: (e: LiveEvent) => void): boolean {
  const [live, setLive] = useState(false);
  const handler = useRef(onEvent);
  useEffect(() => { handler.current = onEvent; });
  const key = channels.join('|');

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    (async () => {
      try {
        const t = await api<TokenResponse>('/api/core/realtime/token', { method: 'POST', body: { channels: key.split('|') } });
        if (cancelled || !t.available || !t.token || !t.url) return;
        const { RealtimeClient } = await import('@supabase/supabase-js');
        const client = new RealtimeClient(`${t.url.replace(/^http/, 'ws')}/realtime/v1`, { params: { apikey: t.token } });
        client.setAuth(t.token);
        const subs = t.channels.map((name) => {
          const ch = client.channel(name, { config: { private: true } });
          for (const ev of ['idea.upserted', 'idea.removed', 'lookup.changed', 'idea.detail.changed']) {
            ch.on('broadcast', { event: ev }, (msg: { payload: unknown }) => handler.current({ event: ev, payload: msg.payload } as LiveEvent));
          }
          ch.subscribe((status: string) => {
            if (cancelled) return;
            if (status === 'SUBSCRIBED') setLive(true);
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setLive(false);
          });
          return ch;
        });
        cleanup = () => { subs.forEach((c) => void client.removeChannel(c)); client.disconnect(); };
      } catch {
        if (!cancelled) setLive(false); // fall back to polling
      }
    })();
    return () => { cancelled = true; cleanup?.(); setLive(false); };
  }, [key]);

  return live;
}
