import { describe, expect, it } from 'vitest';
import { FieldReportStore, validateFieldReport, createFieldReportAuditApp } from './index';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';
import { StorageUnavailableError } from '../../../../shared-types/src/m2/types';

const body = (over: Record<string, unknown> = {}) => ({
  category: 'KORBAN', description: 'rumah roboh', latitude: -7.5, longitude: 110.4, observed_at: '2026-11-17T01:00:00Z', ...over,
});
const valid = (over: Record<string, unknown> = {}) => { const v = validateFieldReport(body(over)); if (!v.ok) throw new Error(v.message); return v.value; };

describe('validateFieldReport', () => {
  it('accepts a minimal and a full report and keeps only known fields', () => {
    expect(validateFieldReport(body()).ok).toBe(true);
    const full = validateFieldReport({ ...body(), hazard_ref: 'hz-abc', attributes: { korban: 3 }, reporter: 'spoofed' });
    expect(full).toMatchObject({ ok: true });
    expect(JSON.stringify(full)).not.toContain('spoofed');
  });

  it.each([
    ['not an object', 'x'], ['unknown category', body({ category: 'X' })], ['empty description', body({ description: '' })],
    ['description too long', body({ description: 'a'.repeat(4001) })], ['latitude out of range', body({ latitude: 91 })],
    ['longitude not a number', body({ longitude: '1' })], ['bad timestamp', body({ observed_at: 'nope' })],
    ['attributes not an object', body({ attributes: [] })],
  ])('rejects %s', (_name, input) => {
    expect(validateFieldReport(input).ok).toBe(false);
  });
});

describe('FieldReportStore', () => {
  const setup = () => {
    const storage = new InMemoryStorage();
    let now = Date.parse('2026-11-17T02:00:00Z');
    return { storage, store: new FieldReportStore(storage, { clock: () => (now += 10) }) };
  };

  it('writes the report and a pending marker before returning, with a deterministic id', async () => {
    const { storage, store } = setup();
    const r = await store.accept('lapangan-client', 'key-1', valid(), 'c-1');
    expect(r.duplicate).toBe(false);
    expect(r.report_id).toMatch(/^fr-/);
    expect(await storage.getDoc('field_reports', `r:${r.report_id}`)).toMatchObject({ reporter: 'lapangan-client', processed_at: null });
    expect(await storage.getDoc('field_reports', `p:${r.report_id}`)).not.toBeNull();
    expect((await new FieldReportStore(storage).accept('lapangan-client', 'key-1', valid(), 'c-2')).report_id).toBe(r.report_id);
  });

  it('treats the same key from another reporter as another report', async () => {
    const { store } = setup();
    const a = await store.accept('client-a', 'same', valid(), 'c');
    const b = await store.accept('client-b', 'same', valid(), 'c');
    expect(a.report_id).not.toBe(b.report_id);
  });

  it('counts a repeat once as a duplicate and returns the original received_at', async () => {
    const { store } = setup();
    const first = await store.accept('c', 'k', valid(), 'c-1');
    const again = await store.accept('c', 'k', valid({ description: 'different text' }), 'c-2');
    await store.accept('c', 'k', valid(), 'c-2'); // the same request retried by a gateway: same correlation id
    expect(again).toMatchObject({ duplicate: true, report_id: first.report_id, received_at: first.received_at });
    expect(await store.audit({ limit: 10 })).toMatchObject({ accepted_total: 1, duplicates_dropped_total: 1, processed_total: 0, partial: false });
    await store.accept('c', 'k', valid(), 'c-3'); // a genuinely new repeat
    expect((await store.audit({ limit: 10 })).duplicates_dropped_total).toBe(2);
  });

  it('sweeps pending reports exactly once and a second sweep changes nothing', async () => {
    const { store } = setup();
    for (let i = 0; i < 5; i++) await store.accept('c', `k${i}`, valid(), `c${i}`);
    expect(await store.sweep(1)).toEqual({ processed: 5, cleaned: 0 });
    expect(await store.sweep(1)).toEqual({ processed: 0, cleaned: 0 });
    expect(await store.audit({ limit: 10 })).toMatchObject({ accepted_total: 5, processed_total: 5 });
  });

  it('survives a crash between marking processed and deleting the marker (no double count)', async () => {
    const { storage, store } = setup();
    const r = await store.accept('c', 'k', valid(), 'c1');
    const doc = await storage.getDoc<Record<string, unknown>>('field_reports', `r:${r.report_id}`);
    await storage.putDoc('field_reports', `r:${r.report_id}`, { ...doc, processed_at: '2026-11-17T02:00:05.000Z' }, { fence: 1, idempotencyKey: 'x', correlationId: 'x', fenceName: 'field-reports' });
    expect(await store.sweep(1)).toEqual({ processed: 0, cleaned: 1 }); // marker cleaned, not re-processed
    expect((await store.audit({ limit: 10 })).processed_total).toBe(1);
    expect(await storage.getDoc('field_reports', `p:${r.report_id}`)).toBeNull();
  });

  it('repairs a lost pending marker (reconcile scan and duplicate request)', async () => {
    const { storage, store } = setup();
    const a = await store.accept('c', 'a', valid(), 'c1');
    const b = await store.accept('c', 'b', valid(), 'c2');
    const ctx = { fence: 1, idempotencyKey: 'x', correlationId: 'x', fenceName: 'field-reports' };
    await storage.deleteDoc('field_reports', `p:${a.report_id}`, ctx);
    await storage.deleteDoc('field_reports', `p:${b.report_id}`, ctx);
    expect(await store.reconcile(1)).toBe(2);
    await storage.deleteDoc('field_reports', `p:${a.report_id}`, ctx);
    await store.accept('c', 'a', valid(), 'c3'); // client retry repairs it too
    expect(await storage.getDoc('field_reports', `p:${a.report_id}`)).not.toBeNull();
    expect(await store.sweep(1)).toMatchObject({ processed: 2 });
  });

  it('pages the audit items without gap or duplicate', async () => {
    const { store } = setup();
    for (let i = 0; i < 7; i++) await store.accept('c', `k${i}`, valid(), `c${i}`);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.audit({ limit: 3, cursor });
      expect(page.accepted_total).toBe(7);
      ids.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
  });

  it('does not answer when the ring is unavailable (so the handler can return 503, never 202)', async () => {
    const { storage, store } = setup();
    for (const unit of storage.units()) storage.setUnitState(unit, 'DOWN');
    await expect(store.accept('c', 'k', valid(), 'c1')).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('serves GET /internal/audit/field-reports with the audit token', async () => {
    const { store } = setup();
    await store.accept('c', 'k', valid(), 'c1');
    const app = createFieldReportAuditApp(store, 'audit');
    expect((await app.inject({ method: 'GET', url: '/internal/audit/field-reports' })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/internal/audit/field-reports', headers: { authorization: 'Bearer audit' } });
    expect(ok.json()).toMatchObject({ accepted_total: 1, processed_total: 0, duplicates_dropped_total: 0 });
    expect((await app.inject({ method: 'GET', url: '/internal/audit/field-reports?limit=0', headers: { authorization: 'Bearer audit' } })).statusCode).toBe(400);
  });
});
