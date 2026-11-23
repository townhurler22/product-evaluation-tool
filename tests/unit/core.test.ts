import { describe, expect, it } from 'vitest';
import { listMigrations } from '../../db/migrate';
import { REQUIRED_MIGRATION } from '@/server/schema-version';
import { ApiError, toErrorBody } from '@/server/http/errors';
import { isSessionLive, needsRefresh, type SessionData } from '@/modules/core/auth/session';
import { hashIp, normaliseEmail } from '@/modules/core/util';

describe('error envelope (ARC-08, ARC-09)', () => {
  it('maps codes to statuses and keeps details', () => {
    const { status, body } = toErrorBody(new ApiError('conflict', 'This idea changed since you loaded it.', { version: 3 }), 'r1');
    expect(status).toBe(409);
    expect(body).toEqual({ code: 'conflict', message: 'This idea changed since you loaded it.', details: { version: 3 } });
  });

  it('never leaks unexpected exception text', () => {
    const { status, body } = toErrorBody(new Error('password=hunter2 at db.ts:12'), 'req-9');
    expect(status).toBe(500);
    expect(body).toEqual({ code: 'internal', message: 'Something went wrong', requestId: 'req-9' });
  });
});

describe('session lifetime (ARC-11)', () => {
  const base: SessionData = { userId: 'u', sessionId: 's', sessionEpoch: 0, issuedAt: 0, seenAt: 0 };
  const h = 3_600_000;
  it('expires after 12 h idle', () => {
    expect(isSessionLive({ ...base, issuedAt: 0, seenAt: 0 }, 11 * h)).toBe(true);
    expect(isSessionLive({ ...base, issuedAt: 0, seenAt: 0 }, 12 * h + 1)).toBe(false);
  });
  it('expires after 7 days even when active', () => {
    expect(isSessionLive({ ...base, issuedAt: 0, seenAt: 7 * 24 * h - 1 }, 7 * 24 * h)).toBe(false);
  });
  it('refreshes the idle window at most hourly', () => {
    expect(needsRefresh({ ...base, seenAt: 0 }, 30 * 60_000)).toBe(false);
    expect(needsRefresh({ ...base, seenAt: 0 }, h + 1)).toBe(true);
  });
});

describe('personal data handling (ARC-43)', () => {
  it('normalises emails', () => expect(normaliseEmail('  Shane@Example.COM ')).toBe('shane@example.com'));
  it('hashes IPs with a salt that rotates daily', () => {
    const d1 = new Date('2026-11-23T10:00:00Z');
    const d2 = new Date('2026-11-24T10:00:00Z');
    expect(hashIp('203.0.113.7', d1)).toBe(hashIp('203.0.113.7', d1));
    expect(hashIp('203.0.113.7', d1)).not.toBe(hashIp('203.0.113.7', d2));
    expect(hashIp('203.0.113.7', d1)).not.toContain('203');
  });
});

describe('schema version (NFR-43)', () => {
  it('build requires the newest migration', () => {
    expect(REQUIRED_MIGRATION).toBe(listMigrations().at(-1)!.id);
  });
});
