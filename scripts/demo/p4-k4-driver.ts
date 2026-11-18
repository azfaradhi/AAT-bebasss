import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { StorageClient } from '../../shared-types/src/m2/types';
import { createIngestContext } from '../../services/aggregator/src/ingest/context';
import { FireSink } from '../../services/satellite-processor/src/fire/fire-sink';
import { FeedClient } from '../../services/satellite-processor/src/feed-client';
import { SatelliteMetrics } from '../../services/satellite-processor/src/metrics';
import { runSatellite } from '../../services/satellite-processor/src/processor';
import type { SatFrame } from '../../services/satellite-processor/src/sink';
import { InMemoryCoordinator } from '../../services/satellite-processor/test-support/contract-fakes/fakes/in-memory-coordinator';
import { InMemoryStorage } from '../../services/satellite-processor/test-support/contract-fakes/fakes/in-memory-storage';

const FEED = process.env.FEED_URL ?? 'http://127.0.0.1:18101';
const OUT = process.env.OUT_DIR ?? '/tmp/p4-k4';
const WRITE_LATENCY_MS = Number(process.env.WRITE_LATENCY_MS ?? 0); // models a replicated ring write
const BATCH = Number(process.env.SAT_BATCH_SIZE ?? 500);
const CONCURRENCY = Number(process.env.WRITE_CONCURRENCY ?? 32);
const CHECKPOINT = Number(process.env.SAT_CHECKPOINT_EVERY_N ?? 500);
const FLUSH_MS = Number(process.env.SAT_FLUSH_INTERVAL_MS ?? 250);
const CATCH_UP_LIMIT_S = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function slowRing(ring: InMemoryStorage): StorageClient {
  if (WRITE_LATENCY_MS === 0) return ring;
  return new Proxy(ring, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const isWrite = ['putDoc', 'deleteDoc', 'upsertEvent', 'tombstoneEvent'].includes(String(prop));
      return async (...args: unknown[]) => { if (isWrite) await sleep(WRITE_LATENCY_MS); return (value as (...a: unknown[]) => unknown).apply(target, args); };
    },
  }) as StorageClient;
}

async function exportEvents(ring: InMemoryStorage): Promise<string> {
  const events = (await ring.listEvents({ source: 'SATELIT', limit: 100_000 })).items
    .map(({ ingested_at: _i, ...rest }) => rest).sort((a, b) => (a.hazard_id < b.hazard_id ? -1 : 1));
  return JSON.stringify(events);
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const session = (await (await fetch(`${FEED}/v1/session`)).json()) as { latest_offset: number };
  const stats0 = (await (await fetch(`${FEED}/admin/stats`)).json()) as { framesSent: number };

  const ring = new InMemoryStorage();
  const storage = slowRing(ring);
  const coordinator = new InMemoryCoordinator(ring, 'burst');
  const metrics = new SatelliteMetrics();
  const sink = new FireSink(storage, Date.now, undefined, CONCURRENCY);
  const delivered: number[] = [];
  const tracking = { apply: async (batch: SatFrame[], ctx: Parameters<FireSink['apply']>[1]) => { for (const f of batch) delivered.push(f.offset); await sink.apply(batch, ctx); } };

  const info = (await (await fetch(`${FEED}/admin/info`)).json()) as { first_id: number; last_id: number; total: number };
  const series: string[] = ['t_s,sent,committed,lag_frames,rss_mb'];
  let rssPeak = 0;
  let lagPeak = 0;
  const t0 = Date.now();
  let sentDoneAt: number | null = null;
  const sampler = setInterval(async () => {
    const s = (await (await fetch(`${FEED}/admin/stats`)).json()) as { framesSent: number };
    const sent = s.framesSent - stats0.framesSent;
    const head = info.first_id + sent - 1; // offset of the newest frame the feed has produced
    const committed = Math.max(metrics.committedOffset, info.first_id - 1);
    const lag = Math.max(0, head - committed);
    const rss = process.memoryUsage().rss / 1048576;
    rssPeak = Math.max(rssPeak, rss);
    lagPeak = Math.max(lagPeak, lag);
    series.push(`${((Date.now() - t0) / 1000).toFixed(2)},${sent},${committed},${lag},${rss.toFixed(1)}`);
    if (sentDoneAt === null && sent >= info.total) sentDoneAt = Date.now();
  }, 250);

  const done = runSatellite({
    coordinator, ingest: createIngestContext({ storage: ring, env: {} }), sink: tracking, metrics,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    client: new FeedClient({ baseUrl: FEED, token: 'x', idleTimeoutMs: 20_000 }),
    config: { SAT_CHECKPOINT_EVERY_N: CHECKPOINT, SAT_BATCH_SIZE: BATCH, SAT_FLUSH_INTERVAL_MS: FLUSH_MS, SAT_RECONNECT_MIN_MS: 5, SAT_RECONNECT_MAX_MS: 100, POD_NAME: 'burst' },
  });
  const deadline = Date.now() + 300_000;
  while (metrics.committedOffset !== session.latest_offset && Date.now() < deadline) await sleep(20);
  const caughtUpAt = Date.now();
  clearInterval(sampler);
  await coordinator.stop();
  await done;

  const total = delivered.length;
  const unique = new Set(delivered);
  const sorted = [...unique].sort((a, b) => a - b);
  const gaps = sorted.filter((o, i) => i > 0 && o !== sorted[i - 1] + 1).length;
  const catchUpS = sentDoneAt === null ? 0 : Math.max(0, (caughtUpAt - sentDoneAt) / 1000);
  const p50 = metrics.percentile(0.5)!;
  const p95 = metrics.percentile(0.95)!;
  const p99 = metrics.percentile(0.99)!;

  // reference: the same frames applied in one fault-free pass with large batches, no feed involved
  const refRing = new InMemoryStorage();
  const ref = new FireSink(refRing);
  const frames: SatFrame[] = [];
  const all = (await (await fetch(`${FEED}/admin/frames`)).json()) as Array<{ id: number; event: string; data: Record<string, unknown> }>;
  for (const f of all) if (f.event !== 'heartbeat') frames.push({ offset: f.id, kind: f.event as SatFrame['kind'], data: f.data });
  for (let i = 0; i < frames.length; i += 5000) await ref.apply(frames.slice(i, i + 5000), { fence: 1, signal: new AbortController().signal });
  const a = await exportEvents(ring);
  const b = await exportEvents(refRing);
  const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

  const summary = {
    config: { frames: info.total, batch: BATCH, checkpoint_every: CHECKPOINT, flush_interval_ms: FLUSH_MS, write_concurrency: CONCURRENCY, simulated_ring_write_latency_ms: WRITE_LATENCY_MS },
    duration_s: (caughtUpAt - t0) / 1000, throughput_fps: Math.round(total / ((caughtUpAt - t0) / 1000)),
    lag_peak_frames: lagPeak, catch_up_after_burst_s: Number(catchUpS.toFixed(2)),
    event_to_store_seconds: { p50, p95, p99, samples: metrics.samples.length },
    rss_peak_mb: Number(rssPeak.toFixed(1)), delivered_frames: total, unique_offsets: unique.size, gaps,
    events: { burst: JSON.parse(a).length, reference: JSON.parse(b).length, identical: a === b, sha: sha(a) },
  };
  writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(`${OUT}/lag-series.csv`, series.join('\n') + '\n');
  console.log(JSON.stringify(summary, null, 2));

  const rows: Array<[string, string, boolean]> = [
    ['no data lost: unique offsets == frames, no gaps', `${unique.size} unique, ${gaps} gaps`, unique.size === info.total && gaps === 0],
    ['final events == fault-free reference', `${summary.events.burst} / ${summary.events.reference}`, summary.events.identical],
    [`catch-up after the burst ends <= ${CATCH_UP_LIMIT_S} s`, `${summary.catch_up_after_burst_s} s`, summary.catch_up_after_burst_s <= CATCH_UP_LIMIT_S],
    ['memory stays bounded (rss peak)', `${summary.rss_peak_mb} MiB`, summary.rss_peak_mb < 800],
  ];
  for (const [name, value, ok] of rows) console.log(`${name.padEnd(52)} | ${value.padEnd(24)} | ${ok ? 'PASS' : 'FAIL'}`);
  const failed = rows.filter((r) => !r[2]).length;
  console.log(failed === 0 ? '\nPASS' : `\nFAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
