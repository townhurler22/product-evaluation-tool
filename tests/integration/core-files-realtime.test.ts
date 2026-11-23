// ARC-26 to ARC-30, SEC-28/29 (files); §3.7 realtime token; retention jobs.
import { beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { freshDb } from '../db';
import { call } from '../http';
import { MemoryStorage, setStorage } from '@/modules/core/files/storage';
import {
  deleteFiles, discardUploads, insertFileRows, prepareUpload, registerFileOwnerResolver, signFileUrls, sniffImage, sweepFiles,
} from '@/modules/core/files/service';
import { authoriseChannels, mintRealtimeToken, registerChannelRule } from '@/modules/core/realtime';
import { POST as tokenRoute } from '@/app/api/core/realtime/token/route';
import { requestMagicLink } from '@/modules/core/auth/sign-in';
import { GET as callback } from '@/app/api/auth/callback/route';
import { drainJobs, enqueue } from '@/modules/core/jobs';
import '@/server/jobs-registry';

let ctx: Awaited<ReturnType<typeof freshDb>>;
let store: MemoryStorage;
beforeEach(async () => { ctx = await freshDb(); store = new MemoryStorage(); setStorage(store); });

const png = () => sharp({ create: { width: 8, height: 6, channels: 3, background: '#336699' } }).png().toBuffer();
const jpegWithGps = () => sharp({ create: { width: 8, height: 6, channels: 3, background: '#aa0000' } })
  .jpeg().withExif({ IFD0: { Copyright: 'secret-owner', ImageDescription: 'home address' } }).toBuffer();

const input = async (bytes?: Buffer) => ({
  module: 'fh' as const, ownerKind: 'insight', ownerId: 'owner-1', bytes: bytes ?? await png(), createdBy: 'u1', maxBytes: 5 * 1024 * 1024,
});

describe('files', () => {
  it('sniffs bytes, not names (ARC-27)', async () => {
    expect(sniffImage(await png())).toBe('image/png');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml');
  });

  it('refuses SVG and GIF with 415, and a declared-type mismatch with 415 file_type_mismatch', async () => {
    await expect(prepareUpload(await input(Buffer.from('<svg/>')))).rejects.toMatchObject({ status: 415 });
    await expect(prepareUpload(await input(Buffer.from('GIF89a' + 'x'.repeat(20))))).rejects.toMatchObject({ status: 415 });
    await expect(prepareUpload({ ...(await input()), declaredType: 'image/jpeg' }))
      .rejects.toMatchObject({ status: 415, details: { reason: 'file_type_mismatch' } });
  });

  it('enforces the route size cap with 413', async () => {
    await expect(prepareUpload({ ...(await input()), maxBytes: 10 })).rejects.toMatchObject({ status: 413 });
  });

  it('strips EXIF metadata but keeps format and dimensions (SEC-28)', async () => {
    const original = await jpegWithGps();
    expect(original.toString('latin1')).toContain('secret-owner');
    const f = await prepareUpload(await input(original));
    const stored = store.objects.get(f.storage_key)!.bytes;
    expect(stored.toString('latin1')).not.toContain('secret-owner');
    const meta = await sharp(stored).metadata();
    expect([meta.format, meta.width, meta.height, meta.exif]).toEqual(['jpeg', 8, 6, undefined]);
  });

  it('storage keys never include user input (ARC-26)', async () => {
    const f = await prepareUpload({ ...(await input()), originalName: '../../etc/passwd.png' });
    expect(f.storage_key).toMatch(/^fh\/insight\/owner-1\/[0-9a-f-]{36}$/);
    expect(f.original_name).toBe('../../etc/passwd.png'); // kept only as metadata
  });

  it('answers 503 files_unavailable when storage is down, before any row (ARC-30)', async () => {
    store.down = true;
    await expect(prepareUpload(await input())).rejects.toMatchObject({ status: 503, code: 'files_unavailable' });
    const { rows } = await ctx.pg.query('SELECT 1 FROM core_file');
    expect(rows).toEqual([]);
  });

  it('owner transaction failure discards the upload (ING-25)', async () => {
    const f = await prepareUpload(await input());
    await discardUploads([f]);
    expect(store.objects.size).toBe(0);
  });

  it('delete after commit; a failed storage delete is marked and retried by the sweep (ARC-29)', async () => {
    const f = await prepareUpload(await input());
    await insertFileRows(ctx.db, [f]);
    store.failRemove = true;
    await deleteFiles([f.id]);
    expect((await ctx.pg.query('SELECT deleted_at IS NOT NULL AS marked FROM core_file')).rows).toEqual([{ marked: true }]);
    store.failRemove = false;
    expect(await sweepFiles()).toMatchObject({ retried: 1 });
    expect(store.objects.size).toBe(0);
    expect((await ctx.pg.query('SELECT 1 FROM core_file')).rows).toEqual([]);
  });

  it('the sweep removes files whose owner no longer exists', async () => {
    registerFileOwnerResolver('fh', 'insight', async () => new Set(['someone-else']));
    const f = await prepareUpload(await input());
    await insertFileRows(ctx.db, [f]);
    expect(await sweepFiles()).toMatchObject({ orphaned: 1 });
    expect(store.objects.size).toBe(0);
  });

  it('signed URLs last 15 minutes and skip deleted files (ARC-28)', async () => {
    const f = await prepareUpload(await input());
    await insertFileRows(ctx.db, [f]);
    const urls = await signFileUrls([f.id, 'missing-id']);
    expect(Object.keys(urls)).toEqual([f.id]);
    expect(urls[f.id].url).toContain('ttl=900');
  });
});

describe('realtime authorisation (§3.7)', () => {
  const principal = { userId: 'u1', sessionId: 's1', role: 'MEMBER' as const, isFeedbackAdmin: false, isWorkspaceAdmin: false };

  it('grants only channels whose rule admits the caller; malformed names are dropped', async () => {
    registerChannelRule('jb.board', async (_p, id) => id === 'board-ok');
    const got = await authoriseChannels(principal, ['fh.workspace', 'jb.board.board-ok', 'jb.board.board-no', 'nope', "x'; drop"]);
    expect(got).toEqual(['fh.workspace', 'jb.board.board-ok']);
  });

  it('mints a 15-minute HS256 token carrying exactly the granted channels', () => {
    process.env.SUPABASE_JWT_SECRET = 'jwt-secret-for-tests-0123456789abcdef';
    const t = mintRealtimeToken(principal, ['fh.workspace'], 1_800_000_000)!;
    const [, payload] = t.token.split('.');
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({
      sub: 'u1', role: 'authenticated', channels: ['fh.workspace'], exp: 1_800_000_000 + 900,
    });
    delete process.env.SUPABASE_JWT_SECRET;
  });

  it('route works without realtime configured (ARC-25) and needs a session', async () => {
    expect((await call(tokenRoute, { method: 'POST', body: { channels: ['fh.workspace'] } })).status).toBe(401);
    const link = await requestMagicLink({ email: 'owner@example.com', ipHash: null, origin: 'http://x' });
    const cookie = (await call(callback, { path: `/api/auth/callback?token=${encodeURIComponent(new URL(link!).searchParams.get('token')!)}` })).setCookie!.split(';')[0];
    const r = await call(tokenRoute, { method: 'POST', cookie, body: { channels: ['fh.workspace'] } });
    expect(r.body).toEqual({ available: false, channels: [] });
  });
});

describe('retention jobs (NFR-29)', () => {
  it('prunes old sessions, rate windows and audit rows; keeps recent ones', async () => {
    await ctx.pg.exec(`
      INSERT INTO core_user (id, email, status) VALUES ('0190c3a0-0000-7000-8000-00000000aaaa', 'a@example.com', 'ACTIVE');
      INSERT INTO core_session (id, user_id, expires_at) VALUES
        ('0190c3a0-0000-7000-8000-000000000001', '0190c3a0-0000-7000-8000-00000000aaaa', now() - interval '40 days'),
        ('0190c3a0-0000-7000-8000-000000000002', '0190c3a0-0000-7000-8000-00000000aaaa', now() + interval '1 day');
      INSERT INTO core_rate_window (key, window_start, count) VALUES ('old', now() - interval '2 days', 1), ('new', now(), 1);
      INSERT INTO core_audit_log (id, actor_kind, action, created_at) VALUES
        ('0190c3a0-0000-7000-8000-0000000000a1', 'system', 'old', now() - interval '25 months'),
        ('0190c3a0-0000-7000-8000-0000000000a2', 'system', 'new', now());`);
    await enqueue('core.retention', {});
    await enqueue('core.logs.prune', {});
    expect(await drainJobs()).toEqual({ ran: 2, failed: 0 });
    expect((await ctx.pg.query('SELECT count(*)::int AS n FROM core_session')).rows).toEqual([{ n: 1 }]);
    expect((await ctx.pg.query('SELECT key FROM core_rate_window')).rows).toEqual([{ key: 'new' }]);
    expect((await ctx.pg.query('SELECT action FROM core_audit_log ORDER BY action')).rows).toEqual([{ action: 'new' }]);
  });
});
