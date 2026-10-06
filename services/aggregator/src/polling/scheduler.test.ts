import { describe, expect, it, vi } from 'vitest';
import type { EventPublisher } from '../publisher/eventPublisher';
import type { CanonicalStore } from '../storage/canonical-store';
import { PollingScheduler } from './scheduler';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const store: CanonicalStore = {
  init: async () => undefined,
  upsert: async (event) => ({ event, created: false }),
  list: async () => ({ data: [], meta: { stale_since: null } }),
  getLastSuccessAt: async () => null,
  markSourceFresh: async () => undefined,
  markSourceStale: async () => undefined,
  close: async () => undefined,
};
const publisher: EventPublisher = { publish: async () => undefined };

describe('PollingScheduler', () => {
  it('starts independent source polls concurrently', async () => {
    const bmkg = deferred<[]>();
    const pvmbg = deferred<[]>();
    const started: string[] = [];
    const scheduler = new PollingScheduler({
      intervalMs: 1000,
      lookbackMs: 60000,
      logger,
      store,
      publisher,
      bmkg: { sourceName: 'BMKG', poll: vi.fn(async () => { started.push('BMKG'); return bmkg.promise; }) },
      pvmbg: { sourceName: 'PVMBG', poll: vi.fn(async () => { started.push('PVMBG'); return pvmbg.promise; }) },
    });

    const tick = scheduler.runTick();
    await vi.waitFor(() => expect(started).toEqual(['BMKG', 'PVMBG']));
    bmkg.resolve([]);
    pvmbg.resolve([]);
    await tick;
  });

  it('does not start an overlapping tick', async () => {
    const source = deferred<[]>();
    const scheduler = new PollingScheduler({
      intervalMs: 1000,
      lookbackMs: 60000,
      logger,
      store,
      publisher,
      bmkg: { sourceName: 'BMKG', poll: vi.fn(() => source.promise) },
      pvmbg: { sourceName: 'PVMBG', poll: vi.fn().mockResolvedValue([]) },
    });

    const first = scheduler.runTick();
    await scheduler.runTick();
    expect(logger.warn).toHaveBeenCalledWith({}, 'polling tick skipped because the previous tick is still running');
    source.resolve([]);
    await first;
  });

  it('uses a persisted success timestamp with a lookback window for incremental polling', async () => {
    const lastSuccessAt = new Date('2026-10-06T10:00:00.000Z');
    const bmkgPoll = vi.fn().mockResolvedValue([]);
    const incrementalStore: CanonicalStore = {
      ...store,
      getLastSuccessAt: vi.fn().mockResolvedValue(lastSuccessAt),
    };
    const scheduler = new PollingScheduler({
      intervalMs: 1000,
      lookbackMs: 60000,
      logger,
      store: incrementalStore,
      publisher,
      bmkg: { sourceName: 'BMKG', poll: bmkgPoll },
      pvmbg: { sourceName: 'PVMBG', poll: vi.fn().mockResolvedValue([]) },
    });

    await scheduler.runTick();

    expect(bmkgPoll).toHaveBeenCalledWith('2026-10-06T09:59:00.000Z');
  });
});
