// Save and sync engine (JB-1502, JB-1601 to JB-1608, ARC-23, ARC-25). Framework-free; unit-tested with a fake fetch.
// One batch in flight at a time. The batchId is fixed before the first send and reused on retry (JB-1604).
import { CLIENT_PROTOCOL, rebase, stampBaseVersions, type Op } from '../ops';
import type { BoardStore, ContentIn, RemoteBatch } from './store';

export type SyncStatus =
  | { kind: 'saved' }
  | { kind: 'saving' }
  | { kind: 'offline'; waiting: number }
  | { kind: 'retrying'; waiting: number }
  | { kind: 'rights-lost'; waiting: number }
  | { kind: 'locked' }
  | { kind: 'warning'; message: string };

export interface SyncDeps {
  boardId: string;
  fetch: typeof fetch;
  newId: () => string;
  /** Reloads full content (resync). */
  loadContent: () => Promise<ContentIn>;
  onStatus?: (s: SyncStatus) => void;
  onNotice?: (message: string) => void;
  persist?: (snapshot: ReturnType<BoardStore['outboxSnapshot']>) => void;
  /** P5 (D-27): the board's demand revision, read from every changes poll. */
  onDemandRev?: (rev: number) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export const FLUSH_DELAY_MS = 400;
const MAX_REBASE_ROUNDS = 5;

export class BoardSync {
  private timer: unknown = null;
  private sending = false;
  private pulling: Promise<void> | null = null;
  private rounds = 0;
  private backoff = 0;
  locked = false;
  status: SyncStatus = { kind: 'saved' };

  constructor(readonly store: BoardStore, private readonly d: SyncDeps) {
    store.onLocalEdit = () => { this.d.persist?.(store.outboxSnapshot()); this.schedule(); };
  }

  private setStatus(s: SyncStatus) { this.status = s; this.d.onStatus?.(s); }
  private api(path: string) { return `/api/jb/boards/${this.d.boardId}${path}`; }

  /** JB-1604: 400 ms after the last edit. */
  schedule(delay = FLUSH_DELAY_MS) {
    const set = this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clear = this.d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    if (this.timer) clear(this.timer);
    this.timer = set(() => { this.timer = null; void this.flush(); }, delay);
  }

  async flush(): Promise<void> {
    if (this.sending || this.locked || this.store.readOnly) return;
    const batch = this.store.takeForSend(this.d.newId);
    if (!batch) { this.setStatus({ kind: 'saved' }); return; }
    this.sending = true;
    this.setStatus({ kind: 'saving' });
    let res: Response;
    try {
      res = await this.d.fetch(this.api('/ops'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: batch.batchId, clientId: this.store.clientId, protocol: CLIENT_PROTOCOL, ops: stampBaseVersions(batch.ops, this.store.server) }),
      });
    } catch {
      this.sending = false;
      return this.retryLater(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'retrying');
    }
    this.sending = false;
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      this.backoff = 0; this.rounds = 0;
      const own: RemoteBatch = { seq: body.seq, batchId: batch.batchId, clientId: this.store.clientId, userId: null, ops: batch.ops, results: body.results };
      const r = this.store.applyBatch(own);
      if (r === 'gap') await this.pull();
      else if (r === 'stale' && this.store.inflight?.batchId === batch.batchId) this.store.replaceInflight(null);
      this.d.persist?.(this.store.outboxSnapshot());
    } else if (res.status === 409) {
      // JB-1605: pull changes since our seq (never the whole board), rebase, resend. Up to 5 rounds.
      await this.pull();
      if (this.store.inflight?.batchId === batch.batchId) {
        const { ops, dropped } = rebase(batch.ops, this.store.server);
        this.store.replaceInflight(ops);
        if (dropped) this.d.onNotice?.(`${dropped} of your changes were dropped because someone deleted those items.`);
      }
      if (++this.rounds > MAX_REBASE_ROUNDS) {
        this.rounds = 0;
        this.setStatus({ kind: 'warning', message: 'Your changes are taking a while to sync. They are kept on this device.' });
        return;
      }
    } else if (res.status === 422) {
      // JB-1608: drop that batch, pull, and say why.
      this.store.replaceInflight(null);
      await this.pull();
      this.d.onNotice?.(`Some changes could not be saved: ${body.message ?? 'invalid change'}`);
    } else if (res.status === 403 || res.status === 404) {
      // JB-1306: rights lost mid-session. Read-only, keep the outbox until rights return or the user discards it.
      this.store.replaceInflight(batch.ops);
      this.store.setReadOnly(true);
      this.setStatus({ kind: 'rights-lost', waiting: this.store.unsentCount });
      this.d.persist?.(this.store.outboxSnapshot());
      return;
    } else if (res.status === 426) {
      this.lock(); return; // JB-2003
    } else {
      return this.retryLater('retrying'); // 5xx: keep the batch, retry with back-off
    }
    this.d.persist?.(this.store.outboxSnapshot());
    if (this.store.pending.length || this.store.inflight) return this.flush();
    this.setStatus({ kind: 'saved' });
  }

  private retryLater(kind: 'offline' | 'retrying') {
    this.backoff = Math.min(30_000, this.backoff ? this.backoff * 2 : 1000);
    this.setStatus({ kind, waiting: this.store.unsentCount });
    this.schedule(this.backoff);
  }

  lock() { this.locked = true; this.store.setReadOnly(true); this.setStatus({ kind: 'locked' }); }

  /** ARC-23: pull batches after our seq and apply them in order; resync below compacted_seq (JB-1606). */
  pull(): Promise<void> {
    if (this.pulling) return this.pulling;
    this.pulling = (async () => {
      try {
        for (let page = 0; page < 50; page++) {
          const res = await this.d.fetch(this.api(`/changes?since=${this.store.seq}`));
          if (res.status === 404) { this.store.setReadOnly(true); this.setStatus({ kind: 'rights-lost', waiting: this.store.unsentCount }); return; }
          if (!res.ok) return;
          const body = await res.json();
          if (typeof body.demandRev === 'number') this.d.onDemandRev?.(body.demandRev);
          if (body.resync) { this.store.resync(await this.d.loadContent()); return; }
          for (const b of body.batches as RemoteBatch[]) if (this.store.applyBatch(b) === 'gap') break;
          if (!body.more) return;
        }
      } catch { /* offline: the next poll or reconnect pulls again */ } finally { this.pulling = null; }
    })();
    return this.pulling;
  }

  /** Realtime `ops.applied` (JB-1501/1502): apply if it is the next seq; on a gap, pull. */
  onRemote(b: RemoteBatch) {
    const r = this.store.applyBatch(b);
    if (r === 'gap') void this.pull();
  }

  /** Rights returned (board.meta): editing resumes and the kept outbox is sent. */
  rightsRestored() {
    if (this.locked) return;
    this.store.setReadOnly(false);
    if (this.store.unsentCount) void this.flush(); else this.setStatus({ kind: 'saved' });
  }

  /** pagehide: one keepalive send of whatever is pending (JB-1604). */
  flushOnHide() {
    this.d.persist?.(this.store.outboxSnapshot());
    if (this.sending || this.locked || this.store.readOnly) return;
    const batch = this.store.takeForSend(this.d.newId);
    if (!batch) return;
    const body = JSON.stringify({ batchId: batch.batchId, clientId: this.store.clientId, protocol: CLIENT_PROTOCOL, ops: stampBaseVersions(batch.ops, this.store.server) });
    if (body.length > 60_000) return; // keepalive bodies are capped; the outbox is persisted and resent on the next visit
    try { void this.d.fetch(this.api('/ops'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }); } catch { /* kept */ }
  }

  dispose() {
    const clear = this.d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    if (this.timer) clear(this.timer);
    this.store.onLocalEdit = null;
  }
}

export type { Op };
