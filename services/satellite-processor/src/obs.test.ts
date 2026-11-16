import { describe, expect, it } from 'vitest';
import { InMemoryCoordinator } from '../test-support/contract-fakes/fakes/in-memory-coordinator';
import { InMemoryStorage } from '../test-support/contract-fakes/fakes/in-memory-storage';
import { createIngestContext } from '../../aggregator/src/ingest/context';
import { HttpMetrics, loggerOptions } from '../../../shared-types/src/obs-lite';
import { FeedClient } from './feed-client';
import { SatelliteMetrics } from './metrics';
import { runSatellite } from './processor';
import { buildServer } from './server';
import { CollectingSink } from './sink';

const det = (n: number) => JSON.stringify({ offset: n, detection: { latitude: -1, longitude: 100, acq_date: '2026-11-27', acq_time: 6, satellite: 'N' } });

describe('HttpMetrics', () => {
  it('renders the contract histogram with cumulative buckets and status classes', () => {
    const m = new HttpMetrics('svc');
    m.observe('/x', 'GET', 200, 0.004);
    m.observe('/x', 'GET', 200, 0.3);
    m.observe('/x', 'GET', 503, 12);
    const text = m.render();
    expect(text).toContain('bnpb_http_server_request_duration_seconds_bucket{service="svc",route="/x",method="GET",status_class="2xx",le="0.005"} 1');
    expect(text).toContain('status_class="2xx",le="0.5"} 2');
    expect(text).toContain('status_class="2xx",le="+Inf"} 2');
    expect(text).toContain('bnpb_http_server_request_duration_seconds_count{service="svc",route="/x",method="GET",status_class="5xx"} 1');
  });

  it('is exposed by the processor /metrics with route patterns, not raw urls', async () => {
    const app = buildServer(new SatelliteMetrics(), () => true, () => '');
    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/nope' });
    const text = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(text).toContain('route="/health"');
    expect(text).toContain('route="unmatched"');
  });

  it('logs with the contract fields', () => {
    const o = loggerOptions('svc', { POD_NAME: 'pod-1', NODE_NAME: 'node-a' });
    expect(o.base).toEqual({ service: 'svc', instance: 'pod-1', node: 'node-a' });
    expect(JSON.parse(`{${o.timestamp().slice(1)}}`).ts).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

describe('event-to-store latency and time-based flush', () => {
  it('applies a quiet batch within the flush interval instead of waiting for the stream to end', async () => {
    const storage = new InMemoryStorage();
    const coordinator = new InMemoryCoordinator(storage, 't');
    const sink = new CollectingSink();
    const metrics = new SatelliteMetrics();
    const encoder = new TextEncoder();
    let close: () => void = () => undefined;
    const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(`id: 1\nevent: detection\ndata: ${det(1)}\n\nid: 2\nevent: detection\ndata: ${det(2)}\n\n`));
        close = () => c.close();
      },
    }))) as unknown as typeof fetch;
    const done = runSatellite({
      coordinator, ingest: createIngestContext({ storage, env: {} }), sink, metrics, logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      client: new FeedClient({ baseUrl: 'http://x', token: 't', idleTimeoutMs: 5000, fetchImpl }),
      config: { SAT_CHECKPOINT_EVERY_N: 1000, SAT_BATCH_SIZE: 500, SAT_FLUSH_INTERVAL_MS: 30, SAT_RECONNECT_MIN_MS: 0, SAT_RECONNECT_MAX_MS: 5, POD_NAME: 't' },
      random: () => 0,
    });
    const end = Date.now() + 3000;
    while (sink.frames.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    expect(sink.frames.map((f) => f.offset)).toEqual([1, 2]); // stream is still open: only the timer could have applied them
    expect(metrics.render()).toMatch(/bnpb_sat_event_to_store_seconds_count 2/);
    close();
    await coordinator.stop();
    await done;
  });
});
