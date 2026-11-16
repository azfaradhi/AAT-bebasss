import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS fixture server
import { loadFrames } from '../../../../tools/feed-fixture-server/server.mjs';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';
import type { SatFrame } from '../sink';
import { FireSink } from './fire-sink';

const ctx = { fence: 1, signal: new AbortController().signal };

async function run(frames: SatFrame[], batch: number): Promise<string> {
  const ring = new InMemoryStorage();
  const sink = new FireSink(ring);
  for (let i = 0; i < frames.length; i += batch) await sink.apply(frames.slice(i, i + batch), ctx);
  const events = (await ring.listEvents({ source: 'SATELIT', limit: 100_000 })).items.map(({ ingested_at: _i, ...e }) => e).sort((a, b) => (a.hazard_id < b.hazard_id ? -1 : 1));
  return JSON.stringify(events);
}

describe('batch boundaries never change the result', () => {
  // three chained days of the captured slice: fires are created, closed and finalized as the watermark moves on
  const frames: SatFrame[] = (loadFrames(undefined, 3) as Array<{ id: number; event: string; data: Record<string, unknown> }>)
    .filter((f) => f.event !== 'heartbeat').map((f) => ({ offset: f.id, kind: f.event as SatFrame['kind'], data: f.data }));

  it('gives the same events for batches of 1, 37, 500 and 9000 frames, including fires finalized inside one batch', async () => {
    const expected = await run(frames, 1);
    expect(JSON.parse(expected).length).toBeGreaterThan(100);
    for (const size of [37, 500, 9000]) expect(await run(frames, size), `batch size ${size}`).toBe(expected);
  }, 120_000);
});
