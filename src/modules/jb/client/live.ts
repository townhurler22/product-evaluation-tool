// Live updates for one board (§3.7, JB-1501, JB-1505, JB-1506, ARC-25).
// Realtime when the token endpoint issues a token and a public Supabase key is configured; otherwise polling
// `changes?since=` (1 s while visible, 10 s hidden). Both converge through seq ordering. Presence and cursors
// are realtime-only and degrade quietly.
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { RemoteBatch } from './store';

export interface PresenceUser { userId: string; name: string; colour: string }
export interface Cursor { userId: string; name: string; colour: string; x: number; y: number; at: number }

export interface LiveHandlers {
  onOps: (b: RemoteBatch) => void;
  onPull: () => void;
  onComment: (payload: { thread?: unknown; threadId?: string }, removed: boolean) => void;
  onMeta: () => void;
  onLocked: (reason: string) => void;
  onPresence: (users: PresenceUser[]) => void;
  onCursor: (c: Cursor) => void;
  onMode: (mode: 'realtime' | 'polling' | 'offline') => void;
  /** P5 (PERF-31): `demand.changed {demandRev}`; refetch the overlay. */
  onDemand?: (demandRev: number | undefined) => void;
}

const COLOURS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#4d7c0f'];
export function stableColour(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLOURS[h % COLOURS.length];
}

export const POLL_VISIBLE_MS = 1000;
export const POLL_HIDDEN_MS = 10_000;
export const CURSOR_INTERVAL_MS = 40;

export class BoardLive {
  private channel: RealtimeChannel | null = null;
  private client: SupabaseClient | null = null;
  private poll: ReturnType<typeof setTimeout> | null = null;
  private lastCursor = 0;
  private closed = false;
  mode: 'realtime' | 'polling' | 'offline' = 'polling';

  constructor(private readonly boardId: string, private readonly me: PresenceUser, private readonly h: LiveHandlers) {}

  async start() {
    const ok = await this.tryRealtime().catch(() => false);
    if (!ok) this.startPolling();
  }

  private async tryRealtime(): Promise<boolean> {
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const topic = `jb.board.${this.boardId}`;
    const res = await fetch('/api/core/realtime/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channels: [topic] }) });
    if (!res.ok) return false;
    const t = await res.json();
    if (!t.available || !t.url || !anonKey || !t.channels?.includes(topic)) return false;
    const { createClient } = await import('@supabase/supabase-js');
    if (this.closed) return false;
    this.client = createClient(t.url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    await this.client.realtime.setAuth(t.token);
    const ch = this.client.channel(topic, { config: { private: true, presence: { key: this.me.userId }, broadcast: { self: false } } });
    ch.on('broadcast', { event: 'ops.applied' }, ({ payload }) => this.h.onOps(payload as RemoteBatch))
      .on('broadcast', { event: 'ops.available' }, () => this.h.onPull())
      .on('broadcast', { event: 'comment.upserted' }, ({ payload }) => this.h.onComment(payload, false))
      .on('broadcast', { event: 'comment.removed' }, ({ payload }) => this.h.onComment(payload, true))
      .on('broadcast', { event: 'board.meta' }, () => this.h.onMeta())
      .on('broadcast', { event: 'demand.changed' }, ({ payload }) => this.h.onDemand?.((payload as { demandRev?: number }).demandRev))
      .on('broadcast', { event: 'board.locked' }, ({ payload }) => this.h.onLocked(String((payload as { reason?: string }).reason ?? '')))
      .on('broadcast', { event: 'cursor' }, ({ payload }) => this.h.onCursor({ ...(payload as Cursor), at: Date.now() }))
      .on('presence', { event: 'sync' }, () => {
        const state = ch.presenceState<PresenceUser>();
        this.h.onPresence(Object.values(state).map((v) => v[0]).filter(Boolean));
      });
    this.channel = ch;
    return new Promise((resolve) => {
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          void ch.track(this.me);
          this.setMode('realtime');
          this.stopPolling();
          this.h.onPull(); // ARC-25: on (re)connect, pull what we missed
          resolve(true);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          if (!this.closed) { this.setMode('polling'); this.startPolling(); }
          resolve(false);
        }
      });
    });
  }

  private setMode(m: BoardLive['mode']) { if (this.mode !== m) { this.mode = m; this.h.onMode(m); } }

  private startPolling() {
    if (this.poll || this.closed) return;
    this.setMode('polling');
    const tick = () => {
      if (this.closed || this.mode === 'realtime') { this.poll = null; return; }
      this.h.onPull();
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      this.poll = setTimeout(tick, hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
    };
    this.poll = setTimeout(tick, POLL_VISIBLE_MS);
  }
  private stopPolling() { if (this.poll) clearTimeout(this.poll); this.poll = null; }

  /** JB-1505: cursors in canvas coordinates, at most every 40 ms; realtime only. */
  sendCursor(x: number, y: number) {
    if (!this.channel || this.mode !== 'realtime') return;
    const now = Date.now();
    if (now - this.lastCursor < CURSOR_INTERVAL_MS) return;
    this.lastCursor = now;
    void this.channel.send({ type: 'broadcast', event: 'cursor', payload: { ...this.me, x, y } }).catch(() => {});
  }

  stop() {
    this.closed = true;
    this.stopPolling();
    if (this.channel) void this.channel.unsubscribe();
    if (this.client) void this.client.removeAllChannels();
  }
}
