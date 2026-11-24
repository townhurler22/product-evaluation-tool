// Work that runs after the response is sent (§3.4 step 8): realtime publishes and job draining.
// Uses Next.js `after()`. Outside a request scope (tests, scripts) tasks are queued and run by `flushAfterResponse`,
// so tests stay deterministic and can assert what would have been published.
import { after } from 'next/server';

type Task = () => Promise<unknown>;
const queued: Task[] = [];

const logFailure = (e: unknown) =>
  console.error(JSON.stringify({ level: 'error', msg: 'after-response task failed', err: String(e) }));

export function afterResponse(task: Task): void {
  if (process.env.VITEST) { queued.push(task); return; }
  try {
    after(() => task().catch(logFailure));
  } catch {
    void task().catch(logFailure); // not inside a request (script or job): run now, never fail the caller
  }
}

/** Tests: run every queued task in order. */
export async function flushAfterResponse(): Promise<void> {
  while (queued.length) await queued.shift()!().catch(logFailure);
}

/** Tests: drop queued tasks without running them. */
export function discardAfterResponse(): void { queued.length = 0; }
