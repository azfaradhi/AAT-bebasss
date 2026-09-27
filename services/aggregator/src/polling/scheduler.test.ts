import { describe, expect, it, vi } from 'vitest';
import { PollingScheduler } from './scheduler';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('PollingScheduler', () => {
  it('starts independent source polls concurrently', async () => {
    const bmkg = deferred();
    const pvmbg = deferred();
    const started: string[] = [];
    const scheduler = new PollingScheduler({
      intervalMs: 1000,
      logger,
      sources: [
        { name: 'BMKG-stub', poll: vi.fn(async () => { started.push('BMKG'); await bmkg.promise; }) },
        { name: 'PVMBG-stub', poll: vi.fn(async () => { started.push('PVMBG'); await pvmbg.promise; }) },
      ],
    });

    const tick = scheduler.runTick();
    await vi.waitFor(() => expect(started).toEqual(['BMKG', 'PVMBG']));
    bmkg.resolve();
    pvmbg.resolve();
    await tick;
  });

  it('does not start an overlapping tick', async () => {
    const source = deferred();
    const scheduler = new PollingScheduler({
      intervalMs: 1000,
      logger,
      sources: [{ name: 'source', poll: vi.fn(() => source.promise) }],
    });

    const first = scheduler.runTick();
    await scheduler.runTick();
    expect(logger.warn).toHaveBeenCalledWith({}, 'polling tick skipped because the previous tick is still running');
    source.resolve();
    await first;
  });
});
