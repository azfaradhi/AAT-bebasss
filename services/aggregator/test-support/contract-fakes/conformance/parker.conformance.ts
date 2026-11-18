// Conformance suite for Parker: guards, classification, parking, replay.
import { describe, expect, it } from 'vitest';
import type { Parker, StorageClient } from '../types';
import { ctx } from './storage.conformance';

export interface ParkerHarness { parker: Parker; storage: StorageClient }
const enc = (s: string) => new TextEncoder().encode(s);

export function parkerConformance(name: string, make: () => ParkerHarness): void {
  describe(`Parker conformance: ${name}`, () => {
    it('K1 guard: valid JSON passes', () => {
      const { parker } = make();
      expect(parker.guard(enc('{"a":[1,2,{"b":null}]}'))).toEqual({ ok: true, json: { a: [1, 2, { b: null }] } });
    });

    it('K2 guard classifies malformed input without throwing (truncated JSON, invalid UTF-8, too deep, too large)', () => {
      const { parker } = make();
      expect(parker.guard(enc('{"a":[1,2')).ok).toBe(false);
      expect((parker.guard(enc('{"a":[1,2')) as { reason_code: string }).reason_code).toBe('MALFORMED_JSON');
      expect((parker.guard(new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])) as { reason_code: string }).reason_code).toBe('INVALID_UTF8');
      expect((parker.guard(enc('['.repeat(100_000) + ']'.repeat(100_000))) as { reason_code: string }).reason_code).toBe('NESTING_TOO_DEEP'); // must not stack-overflow
      expect((parker.guard(new Uint8Array(300_000).fill(0x20)) as { reason_code: string }).reason_code).toBe('PAYLOAD_TOO_LARGE');
      expect(parker.guard(enc('')).ok).toBe(false);
      expect(parker.guard(enc('\u0000{}')).ok).toBe(false);
    });

    it('K3 guard order: size is checked before UTF-8/JSON (an oversized garbage body is PAYLOAD_TOO_LARGE)', () => {
      const { parker } = make();
      const big = new Uint8Array(300_000).fill(0xff);
      expect((parker.guard(big) as { reason_code: string }).reason_code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('K4 retryable reasons become status=retrying with next_attempt_at; permanent reasons become parked immediately', async () => {
      const { parker } = make();
      const a = await parker.park({ source: 'PVMBG', raw: enc('{"x":1}'), reason_code: 'DOWNSTREAM_UNAVAILABLE', detail: 'store down' }, ctx());
      expect(a.status).toBe('retrying'); expect(a.retryable).toBe(true); expect(a.next_attempt_at).not.toBeNull();
      const b = await parker.park({ source: 'PVMBG', raw: enc('{"y":1}'), reason_code: 'SCHEMA_INCOMPATIBLE', detail: "field 'level' number -> string" }, ctx());
      expect(b.status).toBe('parked'); expect(b.retryable).toBe(false); expect(b.next_attempt_at).toBeNull();
      expect(b.reason).toBe("schema_incompatible: field 'level' number -> string");
    });

    it('K5 parking the same bytes twice is idempotent (one record, attempts increments) and raw bytes are kept intact', async () => {
      const { parker } = make();
      const raw = enc('{"report_id":"r1","level":"3"}');
      const a = await parker.park({ source: 'PVMBG', raw, reason_code: 'SCHEMA_INCOMPATIBLE', detail: 'x' }, ctx());
      const b = await parker.park({ source: 'PVMBG', raw, reason_code: 'SCHEMA_INCOMPATIBLE', detail: 'x' }, ctx());
      expect(b.message_id).toBe(a.message_id);
      expect(b.attempts).toBe(2);
      expect((await parker.listUnprocessed({ limit: 10 })).items).toHaveLength(1);
      expect(Buffer.from(b.raw_b64, 'base64').toString()).toBe('{"report_id":"r1","level":"3"}');
      expect(b.raw_size).toBe(raw.byteLength); expect(b.raw_sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('K6 retries exhausted → parked with RETRIES_EXHAUSTED, still retryable=true', async () => {
      const { parker } = make();
      let last = await parker.park({ source: 'BMKG', raw: enc('{}'), reason_code: 'TIMEOUT', detail: 't' }, ctx());
      for (let i = 0; i < 10; i++) last = await parker.park({ source: 'BMKG', raw: enc('{}'), reason_code: 'TIMEOUT', detail: 't' }, ctx());
      expect(last.status).toBe('parked'); expect(last.reason_code).toBe('RETRIES_EXHAUSTED'); expect(last.retryable).toBe(true);
    });

    it('K7 listUnprocessed paginates and never shows recovered messages', async () => {
      const { parker } = make();
      for (let i = 0; i < 25; i++) await parker.park({ source: 'PVMBG', raw: enc(`{"i":${i}}`), reason_code: 'SCHEMA_INCOMPATIBLE', detail: 'd' }, ctx());
      const seen: string[] = []; let cursor: string | undefined;
      do { const p = await parker.listUnprocessed({ limit: 10, cursor }); seen.push(...p.items.map((i) => i.message_id)); cursor = p.next_cursor ?? undefined; } while (cursor);
      expect(new Set(seen).size).toBe(25);
      await parker.replay({}, async () => undefined, ctx());
      expect((await parker.listUnprocessed({ limit: 100 })).items).toHaveLength(0);
    });

    it('K8 replay is sequential per ordering_key (arrival order), idempotent, and stops a key at its first failure', async () => {
      const { parker } = make();
      const order: string[] = [];
      for (const [i, n] of [[1, 'a1'], [2, 'a2'], [3, 'a3']] as const) {
        await parker.park({ source: 'PVMBG', raw: enc(JSON.stringify({ k: 'A', n })), reason_code: 'SCHEMA_INCOMPATIBLE', detail: 'd', orderingKey: 'A' }, ctx());
        await new Promise((r) => setTimeout(r, 2 + i)); // distinct received_at
      }
      await parker.park({ source: 'PVMBG', raw: enc('{"k":"B"}'), reason_code: 'SCHEMA_INCOMPATIBLE', detail: 'd', orderingKey: 'B' }, ctx());
      const r1 = await parker.replay({}, async (raw) => { const j = JSON.parse(Buffer.from(raw).toString()); order.push(j.n ?? j.k); }, ctx());
      expect(r1.recovered).toBe(4);
      expect(order.filter((x) => x.startsWith('a'))).toEqual(['a1', 'a2', 'a3']);
      const r2 = await parker.replay({}, async () => { throw new Error('must not run again'); }, ctx());
      expect(r2.considered).toBe(0); // idempotent
      expect(r2.skipped_already_recovered).toBe(4);
    });

    it('K9 replay failure leaves the message parked, bumps attempts, and does not process later messages of the same key', async () => {
      const { parker } = make();
      await parker.park({ source: 'PVMBG', raw: enc('{"n":1}'), reason_code: 'SCHEMA_INCOMPATIBLE', detail: 'd', orderingKey: 'K' }, ctx());
      await new Promise((r) => setTimeout(r, 5));
      await parker.park({ source: 'PVMBG', raw: enc('{"n":2}'), reason_code: 'SCHEMA_INCOMPATIBLE', detail: 'd', orderingKey: 'K' }, ctx());
      const calls: number[] = [];
      const rep = await parker.replay({}, async (raw) => { const n = JSON.parse(Buffer.from(raw).toString()).n; calls.push(n); throw new Error('still incompatible'); }, ctx());
      expect(calls).toEqual([1]); // key order preserved: 2 is not attempted past 1's failure
      expect(rep.still_failing).toBe(1);
      expect((await parker.listUnprocessed({ limit: 10 })).items).toHaveLength(2);
    });
  });
}
