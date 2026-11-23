// ING-40 signing test vector. Every intake client library must reproduce these exact values.
import { describe, expect, it } from 'vitest';
import { deriveSecret, EMPTY_BODY_SHA256, sha256Hex, sign, signaturesMatch, timestampFresh } from '@/modules/core/intake/signing';

const MASTER = Buffer.from('test-master-key-0123456789abcdef0123', 'utf8');
const BODY = '{"type":"feature_request","title":"Export to PDF","details":null,"quote":"We need PDF export","quoteVerified":true,"requester":null,"company":null,"call":{"transcriptId":"t-1","title":"Weekly call","date":"2026-11-02","type":"feedback_session","timeInCall":"0:12:30","link":null}}';

describe('ING-40 test vector', () => {
  const secret = deriveSecret(MASTER, 'staging', 'fh', '0190c3a0-0000-7000-8000-000000000001', 'ik_test_1');

  it('derives the secret', () => expect(secret).toBe('0b513e6925d9af07235228dceeb9154c3fc32c868aaf7bf6d9c4c17a2d7ae873'));
  it('hashes the 280-byte body', () => {
    expect(Buffer.byteLength(BODY)).toBe(280);
    expect(sha256Hex(BODY)).toBe('ec6a0b72f103968ed150f0eae140ffdeeba76e9950e78e1be6492c29ba880e48');
  });
  it('signs a call request', () => {
    expect(sign(secret, '1793600000', 't-1:0', '/api/ingest/fh/v1/call-requests', sha256Hex(BODY)))
      .toBe('5b6725338abef1c0ac0bed4f9fa977a14aec1586a2d89d395cbd7f7dbd05d669');
  });
  it('signs _verify with an empty body', () => {
    expect(EMPTY_BODY_SHA256.startsWith('e3b0c442')).toBe(true);
    expect(sign(secret, '1793600000', 'verify-1', '/api/ingest/fh/v1/_verify', EMPTY_BODY_SHA256))
      .toBe('d7181cf2c0add7ad4abeb7cc636c3181d8e6a85d7ea4cb07bb3d8437e7601c4a');
  });
  it('environment is part of the derivation (ING-03)', () => {
    expect(deriveSecret(MASTER, 'production', 'fh', '0190c3a0-0000-7000-8000-000000000001', 'ik_test_1')).not.toBe(secret);
  });
});

describe('comparison and freshness (ING-07)', () => {
  it('compares any lengths without throwing', () => {
    expect(signaturesMatch('a'.repeat(64), 'a'.repeat(64))).toBe(true);
    expect(signaturesMatch('a'.repeat(64), 'short')).toBe(false);
  });
  it('accepts ±300 s only', () => {
    expect(timestampFresh('1000', 1300)).toBe(true);
    expect(timestampFresh('1000', 1301)).toBe(false);
    expect(timestampFresh('1301', 1000)).toBe(false);
    expect(timestampFresh('1e3', 1000)).toBe(false);
  });
});
