import { describe, expect, it, vi } from 'vitest';
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
  claimPendingPublication: async () => null,
  markPublicationSent: async () => undefined,
  releasePublication: async () => undefined,
  list: async () => ({ data: [], meta: { stale_since: null } }),
  getLastSuccessAt: async () => null,
  markSourceFresh: async () => undefined,
  markSourceStale: async () => undefined,
  close: async () => undefined,
};

describe('PollingScheduler', () => {
  it('starts both source polls without waiting for each other', async () => {
    const bmkg = deferred<[]>();
    const pvmbg = deferred<[]>();
    const started: string[] = [];
    const scheduler = new PollingScheduler({
      intervalMs: 1000,
      lookbackMs: 60000,
      logger,
      store,
      bmkg: { sourceName: 'BMKG', poll: vi.fn(async () => { started.push('BMKG'); return bmkg.promise; }) },
      pvmbg: { sourceName: 'PVMBG', poll: vi.fn(async () => { started.push('PVMBG'); return pvmbg.promise; }) },
    });

    const tick = scheduler.runTick();
    await vi.waitFor(() => expect(started).toEqual(['BMKG', 'PVMBG']));
    bmkg.resolve([]);
    pvmbg.resolve([]);
    await tick;
  });

  it('keeps polling BMKG while a PVMBG poll is still running', async () => {
    const slowPvmbg = deferred<[]>();
    const bmkgPoll = vi.fn().mockResolvedValue([]);
    const scheduler = new PollingScheduler({
      intervalMs: 1000,
      lookbackMs: 60000,
      logger,
      store,
      bmkg: { sourceName: 'BMKG', poll: bmkgPoll },
      pvmbg: { sourceName: 'PVMBG', poll: vi.fn(() => slowPvmbg.promise) },
    });

    const pvmbgTick = scheduler.runSourceTick({ sourceName: 'PVMBG', poll: vi.fn(() => slowPvmbg.promise) });
    await scheduler.runSourceTick({ sourceName: 'BMKG', poll: bmkgPoll });
    await scheduler.runSourceTick({ sourceName: 'BMKG', poll: bmkgPoll });

    expect(bmkgPoll).toHaveBeenCalledTimes(2);
    slowPvmbg.resolve([]);
    await pvmbgTick;
  });

  it('does not start an overlapping tick for the same source', async () => {
    const source = deferred<[]>();
    const scheduler = new PollingScheduler({
      intervalMs: 1000,
      lookbackMs: 60000,
      logger,
      store,
      bmkg: { sourceName: 'BMKG', poll: vi.fn(() => source.promise) },
      pvmbg: { sourceName: 'PVMBG', poll: vi.fn().mockResolvedValue([]) },
    });

    const first = scheduler.runSourceTick({ sourceName: 'BMKG', poll: vi.fn(() => source.promise) });
    await scheduler.runSourceTick({ sourceName: 'BMKG', poll: vi.fn(() => source.promise) });
    expect(logger.warn).toHaveBeenCalledWith(
      { source: 'BMKG' },
      'polling tick skipped because the previous tick for this source is still running',
    );
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
      bmkg: { sourceName: 'BMKG', poll: bmkgPoll },
      pvmbg: { sourceName: 'PVMBG', poll: vi.fn().mockResolvedValue([]) },
    });

    await scheduler.runTick();

    expect(bmkgPoll).toHaveBeenCalledWith('2026-10-06T09:59:00.000Z');
  });

  it('still logs the poll failure when marking the source stale is itself refused (deposed leader)', async () => {
    const errors: Array<{ err?: string }> = [];
    const warns: unknown[] = [];
    const log = { info: vi.fn(), warn: (o: unknown) => warns.push(o), error: (o: { err?: string }) => errors.push(o) };
    const scheduler = new PollingScheduler({
      intervalMs: 1000, lookbackMs: 0, logger: log,
      store: { ...store, markSourceStale: async () => { throw new Error('fenced: token 1 < 2'); } },
      bmkg: { sourceName: 'BMKG', poll: async () => { throw new Error('upstream exploded'); } },
      pvmbg: { sourceName: 'PVMBG', poll: async () => [] },
    });
    await scheduler.runTick();
    expect(errors.map((e) => e.err)).toContain('upstream exploded');
    expect(warns).toHaveLength(1);
  });
});
