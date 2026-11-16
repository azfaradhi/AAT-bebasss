import { describe, expect, it } from 'vitest';
import { FieldReportStore } from '../../../shared-types/src/field-reports';
import { InMemoryCoordinator } from '../test-support/contract-fakes/fakes/in-memory-coordinator';
import { InMemoryStorage } from '../test-support/contract-fakes/fakes/in-memory-storage';
import { runFieldReportProcessor, type ProcessorStats } from './processor';

const report = { category: 'KORBAN' as const, description: 'x', latitude: 0, longitude: 100, observed_at: '2026-11-17T00:00:00Z' };
const until = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await cond())) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); }
};

function setup(autostart = true) {
  const storage = new InMemoryStorage();
  const coordinator = new InMemoryCoordinator(storage, 'test');
  const store = new FieldReportStore(storage);
  const stats: ProcessorStats = { processed: 0, cleaned: 0, repaired: 0, sweeps: 0, errors: 0 };
  let done: Promise<void> = Promise.resolve();
  const start = () => { done = runFieldReportProcessor({ coordinator, store, sweepIntervalMs: 5, reconcileIntervalMs: 20, stats, logger: { warn: () => undefined } }); };
  if (autostart) start();
  return { storage, coordinator, store, stats, start, stop: async () => { await coordinator.stop(); await done; } };
}

describe('field report processor', () => {
  it('processes every accepted report exactly once, including ones accepted while it runs', async () => {
    const h = setup();
    for (let i = 0; i < 20; i++) await h.store.accept('c', `k${i}`, report, `c${i}`);
    await until(async () => (await h.store.audit({ limit: 1 })).processed_total === 20);
    for (let i = 20; i < 30; i++) await h.store.accept('c', `k${i}`, report, `c${i}`);
    await until(async () => (await h.store.audit({ limit: 1 })).processed_total === 30);
    await h.stop();
    expect(await h.store.audit({ limit: 1 })).toMatchObject({ accepted_total: 30, processed_total: 30, duplicates_dropped_total: 0 });
    expect(h.stats.processed).toBe(30);
  });

  it('keeps going across a leadership failover without losing or double-processing', async () => {
    const h = setup();
    for (let i = 0; i < 40; i++) await h.store.accept('c', `k${i}`, report, `c${i}`);
    h.coordinator.failover('field-reports');
    for (let i = 40; i < 60; i++) await h.store.accept('c', `k${i}`, report, `c${i}`);
    await until(async () => (await h.store.audit({ limit: 1 })).processed_total === 60);
    await h.stop();
    expect(await h.store.audit({ limit: 1 })).toMatchObject({ accepted_total: 60, processed_total: 60 });
  });

  it('repairs a lost marker through the reconcile scan', async () => {
    const h = setup(false);
    const r = await h.store.accept('c', 'k', report, 'c1');
    await h.storage.deleteDoc('field_reports', `p:${r.report_id}`, { fence: 1, idempotencyKey: 'x', correlationId: 'x', fenceName: 'field-reports' });
    h.start();
    await until(async () => (await h.store.audit({ limit: 1 })).processed_total === 1);
    await h.stop();
    expect(h.stats.repaired).toBe(1);
  });
});
