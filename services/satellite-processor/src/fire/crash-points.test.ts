import { describe, expect, it } from 'vitest';
import type { StorageClient } from '../../../../shared-types/src/m2/types';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';
import { FireSink } from './fire-sink';
import { detFrame, keyOf, retractFrame, updateFrame, type DetOpts } from './fixtures';
import type { SatFrame } from '../sink';

const ctx = { fence: 1, signal: new AbortController().signal };
const P = (n: number, extra: Partial<DetOpts> = {}): DetOpts => ({ lat: -2 + n * 0.004, lon: 110, time: 1200 + n, sat: n % 2 ? 'N' : 'N20', frp: 5 + n, ...extra });

// Batch 1 builds two fires and a bridge candidate; batch 2 merges them, updates one, retracts one (shrink) and re-detects.
const batch1: SatFrame[] = [detFrame(1, P(0)), detFrame(2, P(1)), detFrame(3, P(5)), detFrame(4, P(6)), detFrame(5, P(20))];
const batch2: SatFrame[] = [
  detFrame(6, P(3)), updateFrame(7, keyOf(P(1)), { frp: 40 }), detFrame(8, P(21)), retractFrame(9, keyOf(P(20))), detFrame(10, P(20)),
];

class Crash extends Error {}
function crashingStorage(ring: InMemoryStorage, crashAt: number | null) {
  let writes = 0;
  return new Proxy(ring, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const isWrite = ['putDoc', 'deleteDoc', 'upsertEvent', 'tombstoneEvent'].includes(String(prop));
      return (...args: unknown[]) => {
        if (isWrite && crashAt !== null && ++writes === crashAt) return Promise.reject(new Crash('killed'));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as StorageClient;
}

async function snapshot(ring: InMemoryStorage): Promise<string> {
  const events = (await ring.listEvents({ source: 'SATELIT', limit: 100 })).items.map(({ ingested_at: _i, ...e }) => e).sort((a, b) => (a.hazard_id < b.hazard_id ? -1 : 1));
  return JSON.stringify(events);
}

async function countWrites(): Promise<number> {
  const ring = new InMemoryStorage();
  let n = 0;
  const counting = new Proxy(ring, { get(t, p, r) { const v = Reflect.get(t, p, r) as unknown; return typeof v === 'function' ? (...a: unknown[]) => { if (['putDoc', 'deleteDoc', 'upsertEvent', 'tombstoneEvent'].includes(String(p))) n++; return (v as (...x: unknown[]) => unknown).apply(t, a); } : v; } }) as StorageClient;
  const sink = new FireSink(counting);
  await sink.apply(batch1, ctx);
  const before = n;
  await sink.apply(batch2, ctx);
  return n - before;
}

describe('crash at every write of a batch', () => {
  it('converges to the fault-free result however the process dies, then restarts and replays', async () => {
    const clean = new InMemoryStorage();
    const cleanSink = new FireSink(clean);
    await cleanSink.apply(batch1, ctx);
    await cleanSink.apply(batch2, ctx);
    const expected = await snapshot(clean);
    expect(JSON.parse(expected).length).toBeGreaterThan(0);

    const total = await countWrites();
    expect(total).toBeGreaterThan(10);
    for (let crashAt = 1; crashAt <= total; crashAt++) {
      const ring = new InMemoryStorage();
      await new FireSink(ring).apply(batch1, ctx); // batch 1 fully applied and persisted
      await expect(new FireSink(crashingStorage(ring, crashAt)).apply(batch2, ctx)).rejects.toBeInstanceOf(Crash);

      const restarted = new FireSink(ring); // new process: empty memory
      await restarted.apply(batch2, ctx); // the same batch is delivered again (cursor was not committed)
      expect(await snapshot(ring), `crash at write ${crashAt}/${total}`).toBe(expected);
    }
  });

  it('also converges when the replay overlaps a committed prefix and a second crash hits the replay', async () => {
    const clean = new InMemoryStorage();
    const s = new FireSink(clean);
    await s.apply(batch1, ctx);
    await s.apply(batch2, ctx);
    const expected = await snapshot(clean);

    const total = await countWrites();
    for (let first = 1; first <= total; first += 3) {
      for (let second = 1; second <= total; second += 4) {
        const ring = new InMemoryStorage();
        await new FireSink(ring).apply(batch1, ctx);
        await new FireSink(crashingStorage(ring, first)).apply(batch2, ctx).catch(() => undefined);
        await new FireSink(crashingStorage(ring, second)).apply(batch2, ctx).catch(() => undefined);
        await new FireSink(ring).apply(batch2, ctx);
        expect(await snapshot(ring), `crashes at ${first} then ${second}`).toBe(expected);
      }
    }
  });
});
