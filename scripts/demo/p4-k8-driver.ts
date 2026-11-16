import { createIngestContext } from '../../services/aggregator/src/ingest/context';
import { FeedClient } from '../../services/satellite-processor/src/feed-client';
import { SatelliteMetrics } from '../../services/satellite-processor/src/metrics';
import { runSatellite } from '../../services/satellite-processor/src/processor';
import { CollectingSink } from '../../services/satellite-processor/src/sink';
import { InMemoryCoordinator } from '../../services/satellite-processor/test-support/contract-fakes/fakes/in-memory-coordinator';
import { InMemoryStorage } from '../../services/satellite-processor/test-support/contract-fakes/fakes/in-memory-storage';

const FEED = process.env.FEED_URL ?? 'http://127.0.0.1:18099';
const KILLS = Number(process.env.KILLS ?? 25);

(async () => {
  const stats0 = (await (await fetch(`${FEED}/admin/stats`)).json()) as { framesSent: number };
  const session = (await (await fetch(`${FEED}/v1/session`)).json()) as { latest_offset: number };
  const storage = new InMemoryStorage();
  const coordinator = new InMemoryCoordinator(storage, 'p4-k8');
  const sink = new CollectingSink();
  const metrics = new SatelliteMetrics();
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const done = runSatellite({
    coordinator, ingest: createIngestContext({ storage, env: {} }), sink, metrics, logger: quiet,
    client: new FeedClient({ baseUrl: FEED, token: 'x', idleTimeoutMs: 10_000 }),
    config: { SAT_CHECKPOINT_EVERY_N: 100, SAT_BATCH_SIZE: 100, SAT_FLUSH_INTERVAL_MS: 50, SAT_RECONNECT_MIN_MS: 10, SAT_RECONNECT_MAX_MS: 200, POD_NAME: 'p4-k8' },
  });

  let kills = 0;
  const killer = setInterval(async () => {
    if (kills >= KILLS) return;
    const r = (await (await fetch(`${FEED}/admin/disconnect`, { method: 'POST' })).json()) as { disconnected: boolean };
    if (r.disconnected) kills++;
  }, 120);

  const deadline = Date.now() + 120_000;
  while (metrics.committedOffset < session.latest_offset && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  clearInterval(killer);
  await coordinator.stop();
  await done;

  const offsets = sink.frames.map((f) => f.offset);
  const unique = new Set(offsets);
  const sorted = [...unique].sort((a, b) => a - b);
  const gaps = sorted.filter((o, i) => i > 0 && o !== sorted[i - 1] + 1).length;
  const stats = (await (await fetch(`${FEED}/admin/stats`)).json()) as { connections: number; framesSent: number; starts: number[] };
  const redelivered = offsets.length - unique.size;

  const rows: Array<[string, string, boolean]> = [
    ['connections killed mid-stream', `${kills} (target ${KILLS})`, kills >= KILLS],
    ['server-side connections opened', String(stats.connections), stats.connections > kills],
    ['unique offsets delivered', `${unique.size} (${sorted[0]}..${sorted.at(-1)})`, sorted.at(-1) === session.latest_offset],
    ['gaps in delivered offsets', String(gaps), gaps === 0],
    ['duplicate deliveries to the sink', `${redelivered}`, redelivered === 0],
    ['committed offset == latest', `${metrics.committedOffset} / ${session.latest_offset}`, metrics.committedOffset === session.latest_offset],
    ['frames sent by server vs delivered', `${stats.framesSent - stats0.framesSent} sent, ${offsets.length} delivered`, true],
  ];
  for (const [name, value, ok] of rows) console.log(`${name.padEnd(36)} | ${value.padEnd(40)} | ${ok ? 'PASS' : 'FAIL'}`);
  const failed = rows.filter((r) => !r[2]).length;
  console.log(failed === 0 ? '\nPASS: contiguous offsets, no duplicates across forced reconnects' : `\nFAIL: ${failed} check(s)`);
  process.exit(failed === 0 ? 0 : 1);
})();
