import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from '../db';
import { call } from '../http';
import { POST as drainRoute } from '@/app/api/internal/jobs/drain/route';
import { drainJobs, enqueue, registerJob } from '@/modules/core/jobs';

let ctx: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => { ctx = await freshDb(); });

const jobs = async () =>
  (await ctx.pg.query<{ kind: string; state: string; attempts: number }>('SELECT kind, state, attempts FROM core_job ORDER BY created_at')).rows;

describe('job runner (ARC-31)', () => {
  it('runs a job once and marks it done', async () => {
    const seen: unknown[] = [];
    registerJob('test.ok', async (p) => { seen.push(p); });
    await enqueue('test.ok', { n: 1 });
    expect(await drainJobs()).toEqual({ ran: 1, failed: 0 });
    expect(seen).toEqual([{ n: 1 }]);
    expect(await jobs()).toEqual([{ kind: 'test.ok', state: 'done', attempts: 1 }]);
    expect(await drainJobs()).toEqual({ ran: 0, failed: 0 });
  });

  it('debounces by dedupe key: one queued job per key', async () => {
    registerJob('test.debounce', async () => {});
    await enqueue('test.debounce', { v: 1 }, { dedupeKey: 'idea:1' });
    await enqueue('test.debounce', { v: 2 }, { dedupeKey: 'idea:1' });
    const { rows } = await ctx.pg.query<{ payload: { v: number } }>('SELECT payload FROM core_job');
    expect(rows).toEqual([{ payload: { v: 2 } }]);
  });

  it('retries with back-off and dead-letters after 5 attempts', async () => {
    registerJob('test.fail', async () => { throw new Error('boom'); });
    await enqueue('test.fail', {});
    for (let i = 0; i < 5; i++) {
      await drainJobs();
      await ctx.pg.query(`UPDATE core_job SET run_at = now() WHERE state = 'queued'`); // skip the back-off wait
    }
    expect(await jobs()).toEqual([{ kind: 'test.fail', state: 'dead', attempts: 5 }]);
  });

  it('drain endpoint hides itself without the cron secret', async () => {
    expect((await call(drainRoute, { method: 'POST' })).status).toBe(404);
    const ok = await call(drainRoute, { method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    expect(ok.status).toBe(200);
  });
});
