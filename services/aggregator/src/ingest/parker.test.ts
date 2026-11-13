import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';
import { parkerConformance } from '../../test-support/contract-fakes/conformance/parker.conformance';
import { ctx } from '../../test-support/contract-fakes/conformance/storage.conformance';
import { StorageBackedParker } from './parker';
import { guardBytes, guardHttpBody } from './guard';
import { loadIngestLimits } from './limits';

const enc = (s: string) => new TextEncoder().encode(s);
const reason = (r: ReturnType<typeof guardBytes>) => (r.ok ? 'OK' : r.reason_code);

// The same acceptance suite the reference passes (README §1.4).
parkerConformance('real StorageBackedParker (ingest/)', () => {
  const storage = new InMemoryStorage();
  return { parker: new StorageBackedParker(storage), storage };
});

describe('guard classes (P3-K3)', () => {
  it.each([
    ['valid', '{"a":1}', 'OK'],
    ['empty body', '', 'MALFORMED_JSON'],
    ['whitespace only', '   ', 'MALFORMED_JSON'],
    ['truncated', '{"a":[1,2', 'MALFORMED_JSON'],
    ['NUL byte outside string', '{"a":1}\u0000', 'MALFORMED_JSON'],
    ['NUL byte inside string', '{"a":"x\u0000y"}', 'MALFORMED_JSON'],
    ['trailing garbage', '{"a":1}xyz', 'MALFORMED_JSON'],
    ['html error page', '<html>502</html>', 'MALFORMED_JSON'],
  ])('%s', (_n, body, expected) => {
    expect(reason(guardBytes(enc(body)))).toBe(expected);
  });

  it('UTF-8 BOM is tolerated and stripped', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('{"a":1}')]);
    expect(guardBytes(bytes)).toEqual({ ok: true, json: { a: 1 } });
  });

  it('invalid UTF-8 variants', () => {
    expect(reason(guardBytes(new Uint8Array([0x7b, 0xc3, 0x28, 0x7d])))).toBe('INVALID_UTF8'); // bad continuation
    expect(reason(guardBytes(new Uint8Array([0x7b, 0xed, 0xa0, 0x80, 0x7d])))).toBe('INVALID_UTF8'); // lone surrogate
    expect(reason(guardBytes(new Uint8Array([0x7b, 0xe2, 0x82])))).toBe('INVALID_UTF8'); // truncated sequence
  });

  it('deep nesting: arrays, objects, mixed, and brackets hidden in strings do not count', () => {
    expect(reason(guardBytes(enc('['.repeat(10_000) + ']'.repeat(10_000))))).toBe('NESTING_TOO_DEEP');
    expect(reason(guardBytes(enc('{"a":'.repeat(40) + '1' + '}'.repeat(40))))).toBe('NESTING_TOO_DEEP');
    expect(reason(guardBytes(enc('[{"a":['.repeat(20) + ']}]'.repeat(20))))).toBe('NESTING_TOO_DEEP');
    expect(reason(guardBytes(enc(JSON.stringify({ s: '['.repeat(1000) }))))).toBe('OK');
    expect(reason(guardBytes(enc('['.repeat(32) + ']'.repeat(32))))).toBe('OK'); // exactly at the limit
  });

  it('huge string value: ok just under the size limit, PAYLOAD_TOO_LARGE just over', () => {
    const under = JSON.stringify({ s: 'x'.repeat(262_144 - 10) });
    expect(under.length).toBeLessThanOrEqual(262_144);
    expect(reason(guardBytes(enc(under)))).toBe('OK');
    expect(reason(guardBytes(enc(JSON.stringify({ s: 'x'.repeat(262_144) }))))).toBe('PAYLOAD_TOO_LARGE');
  });

  it('size is measured in bytes, not characters', () => {
    const multi = JSON.stringify({ s: '€'.repeat(90_000) }); // 3 bytes each
    expect(reason(guardBytes(enc(multi), { maxBytes: 262_144 }))).toBe('PAYLOAD_TOO_LARGE');
  });

  it('50 MB body is rejected by size without being decoded', () => {
    const t0 = performance.now();
    expect(reason(guardBytes(new Uint8Array(50 * 1024 * 1024).fill(0xff)))).toBe('PAYLOAD_TOO_LARGE');
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('never throws on random bytes', () => {
    for (let i = 0; i < 200; i++) {
      const b = new Uint8Array(1 + (i * 37) % 500).map((_, j) => (i * 131 + j * 17 + (j >> 2)) & 0xff);
      expect(() => guardBytes(b)).not.toThrow();
    }
  });

  it('content-type mismatch is rejected before parsing, size first', () => {
    expect(reason(guardHttpBody(enc('{"a":1}'), 'text/html; charset=utf-8'))).toBe('MALFORMED_JSON');
    expect(reason(guardHttpBody(enc('{"a":1}'), 'application/json; charset=utf-8'))).toBe('OK');
    expect(reason(guardHttpBody(enc('{"a":1}'), 'application/problem+json'))).toBe('OK');
    expect(reason(guardHttpBody(enc('{"a":1}'), undefined))).toBe('OK');
    expect(reason(guardHttpBody(new Uint8Array(300_000), 'text/html'))).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('configurable limits', () => {
  it('env overrides and defaults', () => {
    expect(loadIngestLimits({})).toEqual({ maxBytes: 262_144, maxDepth: 32, maxAttempts: 8 });
    expect(loadIngestLimits({ MAX_MESSAGE_BYTES: '100', MAX_JSON_DEPTH: '3', PARK_MAX_ATTEMPTS: '2' })).toEqual({ maxBytes: 100, maxDepth: 3, maxAttempts: 2 });
    expect(() => loadIngestLimits({ MAX_JSON_DEPTH: '0' })).toThrow();
    expect(() => loadIngestLimits({ MAX_MESSAGE_BYTES: 'abc' })).toThrow();
  });

  it('parker applies limits and PARK_MAX_ATTEMPTS', async () => {
    const storage = new InMemoryStorage();
    const parker = new StorageBackedParker(storage, { limits: { maxBytes: 10, maxDepth: 2 }, maxAttempts: 2 });
    expect(reason(parker.guard(enc('{"a":"0123456789"}')))).toBe('PAYLOAD_TOO_LARGE');
    expect(reason(parker.guard(enc('[[[1]]]'), { maxBytes: 100 }))).toBe('NESTING_TOO_DEEP');
    const raw = enc('{}');
    const a = await parker.park({ source: 'BMKG', raw, reason_code: 'TIMEOUT', detail: 't' }, ctx());
    expect(a.status).toBe('retrying');
    const b = await parker.park({ source: 'BMKG', raw, reason_code: 'TIMEOUT', detail: 't' }, ctx());
    expect(b.status).toBe('parked');
    expect(b.reason_code).toBe('RETRIES_EXHAUSTED');
    expect(b.retryable).toBe(true);
  });

  it('each reason code maps to the right retryable/status', async () => {
    const parker = new StorageBackedParker(new InMemoryStorage());
    const permanent = ['SCHEMA_INCOMPATIBLE', 'MALFORMED_JSON', 'INVALID_UTF8', 'PAYLOAD_TOO_LARGE', 'NESTING_TOO_DEEP', 'UNKNOWN_ENUM_VALUE', 'MAPPING_ERROR'] as const;
    const transient = ['DOWNSTREAM_UNAVAILABLE', 'STORAGE_PARTIAL', 'TIMEOUT', 'BROKER_UNAVAILABLE', 'RATE_LIMITED'] as const;
    for (const [i, c] of permanent.entries()) {
      const r = await parker.park({ source: 'PVMBG', raw: enc(`{"p":${i}}`), reason_code: c, detail: 'd' }, ctx());
      expect([r.status, r.retryable]).toEqual(['parked', false]);
    }
    for (const [i, c] of transient.entries()) {
      const r = await parker.park({ source: 'PVMBG', raw: enc(`{"t":${i}}`), reason_code: c, detail: 'd' }, ctx());
      expect([r.status, r.retryable]).toEqual(['retrying', true]);
    }
  });

  it('oversized raw is stored truncated with hash and size intact', async () => {
    const parker = new StorageBackedParker(new InMemoryStorage());
    const raw = new Uint8Array(1_200_000).fill(0x41);
    const r = await parker.park({ source: 'BMKG', raw, reason_code: 'PAYLOAD_TOO_LARGE', detail: 'big' }, ctx());
    expect(r.raw_truncated).toBe(true);
    expect(r.raw_size).toBe(1_200_000);
    expect(r.raw_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
