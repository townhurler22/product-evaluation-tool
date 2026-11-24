// Selection and bulk helpers (FH-151, FH-152, FH-154). Pure functions, unit tested as D-32 and D-33.
import { BULK_CHUNK } from '@/modules/fh/domain';

/** D-32: keep only selected ids the user can still see. */
export function pruneSelection(selected: ReadonlySet<string>, visible: Iterable<string>): Set<string> {
  const vis = new Set(visible);
  return new Set([...selected].filter((id) => vis.has(id)));
}

/** A key for "what the user is looking at": changing it clears the selection (view, search, rail, section). */
export const selectionScope = (s: { view: string; search?: string; rail?: unknown; section?: string }) =>
  JSON.stringify([s.section ?? 'ideas', s.view, (s.search ?? '').trim(), s.rail ?? {}]);

export function chunk<T>(xs: T[], size = BULK_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export interface ChunkProgress { done: number; total: number }

/**
 * D-33: sends ids in server-cap chunks, one after another, reporting progress. A failure part-way stops,
 * keeps what committed and reports how far it got: "Accepted 400 of 1,200, then stopped: <reason>".
 */
export async function runChunks<R>(
  ids: string[], send: (chunk: string[]) => Promise<R>, onProgress: (p: ChunkProgress) => void, size = BULK_CHUNK,
): Promise<{ results: R[]; done: number; total: number; error: Error | null }> {
  const results: R[] = [];
  let done = 0;
  onProgress({ done, total: ids.length });
  for (const c of chunk(ids, size)) {
    try {
      results.push(await send(c));
    } catch (e) {
      return { results, done, total: ids.length, error: e instanceof Error ? e : new Error(String(e)) };
    }
    done += c.length;
    onProgress({ done, total: ids.length });
  }
  return { results, done, total: ids.length, error: null };
}

export const fmtCount = (n: number) => n.toLocaleString('en-GB');
