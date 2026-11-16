import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JS fixture server
import { startFixtureServer } from '../../../tools/feed-fixture-server/server.mjs';
import { createIngestContext } from '../../aggregator/src/ingest/context';
import { InMemoryCoordinator } from '../test-support/contract-fakes/fakes/in-memory-coordinator';
import { InMemoryStorage } from '../test-support/contract-fakes/fakes/in-memory-storage';
import { FeedClient } from './feed-client';
import { SatelliteMetrics } from './metrics';
import { runSatellite } from './processor';
import { CollectingSink, type FrameSink, type SatFrame } from './sink';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const baseConfig = { SAT_CHECKPOINT_EVERY_N: 100, SAT_BATCH_SIZE: 50, SAT_RECONNECT_MIN_MS: 0, SAT_RECONNECT_MAX_MS: 5, POD_NAME: 'test' };
const sse = (frames: Array<[number, string, string]>) => frames.map(([id, event, data]) => `id: ${id}\nevent: ${event}\ndata: ${data}\n\n`).join('');
const det = (n: number) => JSON.stringify({ offset: n, detection: { latitude: -1, longitude: 100, acq_date: '2026-11-27', acq_time: 6, satellite: 'N' } });

function harness(opts: { fetchImpl?: typeof fetch; baseUrl?: string; sink?: FrameSink; config?: Partial<typeof baseConfig> } = {}) {
  const storage = new InMemoryStorage();
  const coordinator = new InMemoryCoordinator(storage, 'test');
  const ingest = createIngestContext({ storage, env: {} });
  const metrics = new SatelliteMetrics();
  const sink = opts.sink ?? new CollectingSink();
  const client = new FeedClient({ baseUrl: opts.baseUrl ?? 'http://feed.test', token: 't', idleTimeoutMs: 2000, fetchImpl: opts.fetchImpl });
  const done = runSatellite({ coordinator, ingest, sink, config: { ...baseConfig, ...opts.config }, client, metrics, logger: quiet, random: () => 0 });
  const stop = async () => { await coordinator.stop(); await done; };
  return { storage, coordinator, ingest, metrics, sink, stop };
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const offsetsOf = (frames: SatFrame[]) => frames.map((f) => f.offset);
const contiguous = (offsets: number[]) => offsets.every((o, i) => i === 0 || o === offsets[i - 1] + 1);

let server: Awaited<ReturnType<typeof startFixtureServer>> | null = null;
afterEach(async () => { await server?.close(); server = null; });

describe('against the fixture feed', () => {
  it('reads the whole slice once, contiguous, and commits the last offset', async () => {
    server = await startFixtureServer({});
    const h = harness({ baseUrl: server.url });
    await until(() => h.metrics.committedOffset === server.lastId);
    await h.stop();

    const offsets = offsetsOf((h.sink as CollectingSink).frames);
    expect(offsets[0]).toBe(server.firstId);
    expect(offsets.at(-1)).toBe(server.lastId);
    expect(offsets).toHaveLength(server.lastId - server.firstId + 1);
    expect(contiguous(offsets)).toBe(true);
  });

  it('survives repeated mid-stream disconnects with no gap and no duplicate, resuming at last+1', async () => {
    server = await startFixtureServer({ disconnectEveryN: 250 });
    const h = harness({ baseUrl: server.url });
    await until(() => h.metrics.committedOffset === server.lastId);
    await h.stop();

    const offsets = offsetsOf((h.sink as CollectingSink).frames);
    expect(contiguous(offsets)).toBe(true);
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(server.stats.connections).toBeGreaterThanOrEqual(12);
    const starts: number[] = server.stats.starts;
    expect(starts[0]).toBe(0);
    expect(starts.slice(1).every((s, i) => s >= starts[i])).toBe(true); // a cut before any byte arrived legitimately repeats the same start
  });

  it('after a failover the new term resumes at committed+1', async () => {
    server = await startFixtureServer({ framesPerSecond: 4000 });
    const h = harness({ baseUrl: server.url, config: { SAT_CHECKPOINT_EVERY_N: 100, SAT_BATCH_SIZE: 100 } });
    await until(() => h.metrics.committedOffset >= server.firstId + 400);
    const committedAtFailover = h.metrics.committedOffset;
    h.coordinator.failover('satellite');
    await until(() => h.metrics.committedOffset === server.lastId);
    await h.stop();

    expect(server.stats.starts.some((s: number) => s === committedAtFailover + 1)).toBe(true);
    const unique = [...new Set(offsetsOf((h.sink as CollectingSink).frames))].sort((a, b) => a - b);
    expect(contiguous(unique)).toBe(true);
    expect(unique.at(-1)).toBe(server.lastId);
  }, 20_000);
});

describe('frame handling', () => {
  function scripted(...bodies: string[]) {
    const urls: string[] = [];
    let n = 0;
    const fetchImpl = (async (url: URL) => {
      urls.push(String(url));
      const body = bodies[Math.min(n++, bodies.length - 1)];
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    return { fetchImpl, urls };
  }

  it('ignores a duplicate offset', async () => {
    const { fetchImpl } = scripted(sse([[1, 'detection', det(1)], [2, 'heartbeat', '{"offset":2}'], [2, 'heartbeat', '{"offset":2}'], [3, 'detection', det(3)]]), '');
    const h = harness({ fetchImpl });
    await until(() => h.metrics.committedOffset === 3);
    await h.stop();
    expect(offsetsOf((h.sink as CollectingSink).frames)).toEqual([1, 2, 3]);
    expect(h.metrics.duplicates).toBe(1);
  });

  it('reconnects from last+1 when it detects a gap', async () => {
    const { fetchImpl, urls } = scripted(sse([[1, 'detection', det(1)], [2, 'detection', det(2)], [4, 'detection', det(4)]]), sse([[3, 'detection', det(3)], [4, 'detection', det(4)], [5, 'detection', det(5)]]), '');
    const h = harness({ fetchImpl });
    await until(() => h.metrics.committedOffset === 5);
    await h.stop();
    expect(offsetsOf((h.sink as CollectingSink).frames)).toEqual([1, 2, 3, 4, 5]);
    expect(h.metrics.gaps).toBe(1);
    expect(urls[1]).toContain('from=3');
  });

  it('parks poison frames, keeps the healthy ones and still advances the cursor', async () => {
    const { fetchImpl } = scripted(sse([
      [1, 'detection', det(1)], [2, 'detection', '{"a":'], [3, 'mystery', '{}'], [4, 'update', '{"offset":4}'], [5, 'detection', det(5)],
    ]), '');
    const h = harness({ fetchImpl });
    await until(() => h.metrics.committedOffset === 5);
    const parked = (await h.ingest.parker.listUnprocessed({ limit: 10 })).items;
    await h.stop();

    expect(offsetsOf((h.sink as CollectingSink).frames)).toEqual([1, 5]);
    expect(parked.map((p) => p.reason_code).sort()).toEqual(['MALFORMED_JSON', 'SCHEMA_INCOMPATIBLE', 'UNKNOWN_ENUM_VALUE']);
    expect(parked.every((p) => p.source === 'SATELIT')).toBe(true);
  });

  it('starts a fresh stream from offset 0 and never commits before the sink has applied', async () => {
    const { fetchImpl, urls } = scripted(sse([[1, 'detection', det(1)], [2, 'detection', det(2)]]), '');
    const events: string[] = [];
    const sink: FrameSink = { apply: async (b) => { await new Promise((r) => setTimeout(r, 20)); events.push(`apply:${b.at(-1)!.offset}`); } };
    const h = harness({ fetchImpl, sink });
    const spy = vi.spyOn(h.coordinator, 'commitCursor');
    spy.mockImplementation(async (...args) => { events.push(`commit:${(args[2].position as { offset: number }).offset}`); return InMemoryCoordinator.prototype.commitCursor.apply(h.coordinator, args); });
    await until(() => h.metrics.committedOffset === 2);
    await h.stop();

    expect(urls[0]).toContain('from=0');
    expect(events.indexOf('apply:2')).toBeLessThan(events.indexOf('commit:2'));
  });

  it('stops committing once leadership is lost (zombie leader)', async () => {
    const { fetchImpl } = scripted(sse([[1, 'detection', det(1)]]), '');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const h = harness({ fetchImpl, sink: { apply: async () => { await gate; } } });
    await until(() => h.coordinator.isLeader('satellite'));
    await new Promise((r) => setTimeout(r, 30));
    h.coordinator.failover('satellite');
    release();
    await new Promise((r) => setTimeout(r, 50));
    const cursor = await h.coordinator.readCursor<{ offset: number }>('satellite');
    await h.stop();
    expect(cursor.state).toBeNull();
    expect(h.metrics.committedOffset).toBe(-1);
  });
});
