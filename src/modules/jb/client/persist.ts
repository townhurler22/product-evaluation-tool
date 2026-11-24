// Outbox persistence (JB-1603, PERF-23, NFR-12): IndexedDB per user and board, written at most every
// 250 ms and on pagehide. Without IndexedDB the outbox lives in memory and the editor says so.
import type { BoardStore } from './store';

type Snapshot = ReturnType<BoardStore['outboxSnapshot']>;
const DB_NAME = 'pet-journey-boards';
const STORE = 'outbox';
export const PERSIST_THROTTLE_MS = 250;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export interface OutboxPersistence {
  available: boolean;
  load(): Promise<Snapshot | null>;
  /** Throttled write (≤ 1 per 250 ms). */
  save(s: Snapshot): void;
  /** Immediate write (pagehide). */
  saveNow(s: Snapshot): void;
  clear(): void;
  /** Writes performed so far (PT-11 checks none happen during a drag). */
  writes: number;
}

export async function openOutbox(userId: string, boardId: string): Promise<OutboxPersistence> {
  const db = await openDb();
  const key = `${userId}:${boardId}`;
  let latest: Snapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const out: OutboxPersistence = {
    available: Boolean(db), writes: 0,
    async load() {
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const r = db.transaction(STORE).objectStore(STORE).get(key);
          r.onsuccess = () => resolve((r.result as Snapshot | undefined) ?? null);
          r.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    },
    saveNow(s) {
      latest = null;
      if (!db) return;
      try {
        const empty = !s.inflight && !s.pending.length;
        const tx = db.transaction(STORE, 'readwrite');
        if (empty) tx.objectStore(STORE).delete(key); else tx.objectStore(STORE).put(s, key);
        out.writes++;
      } catch { /* quota or closed: the outbox is still in memory */ }
    },
    save(s) {
      latest = s;
      if (timer) return;
      timer = setTimeout(() => { timer = null; if (latest) out.saveNow(latest); }, PERSIST_THROTTLE_MS);
    },
    clear() { out.saveNow({ seq: 0, inflight: null, pending: [] }); },
  };
  return out;
}
