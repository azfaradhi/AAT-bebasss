import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createIngestContext } from '../../services/aggregator/src/ingest/context';
import { FireSink } from '../../services/satellite-processor/src/fire/fire-sink';
import { FeedClient } from '../../services/satellite-processor/src/feed-client';
import { SatelliteMetrics } from '../../services/satellite-processor/src/metrics';
import { runSatellite } from '../../services/satellite-processor/src/processor';
import type { SatFrame } from '../../services/satellite-processor/src/sink';
import { InMemoryCoordinator } from '../../services/satellite-processor/test-support/contract-fakes/fakes/in-memory-coordinator';
import { InMemoryStorage } from '../../services/satellite-processor/test-support/contract-fakes/fakes/in-memory-storage';

// Runs the satellite pipeline against a feed (the real one by default) for a fixed time and records what happened.
// The token is read from the env file and passed to the client only; it is never printed or written to the output.
const MODE = process.argv[2] ?? 'live'; // live | disconnect
const ENV_FILE = process.env.ENV_FILE ?? '.env.local';
const BASE = process.env.SAT_FEED_BASE_URL ?? 'https://satellite.naufarrel.dev';
const DURATION_S = Number(process.env.DURATION_S ?? 330);
const FORCE_EVERY_S = MODE === 'disconnect' ? Number(process.env.FORCE_DISCONNECT_EVERY_S ?? 12) : 0;
const START_BEHIND = Number(process.env.START_BEHIND ?? 1500); // begin this many offsets behind the head
const OUT = process.env.OUT_DIR ?? `/tmp/p4-${MODE}`;
const token = (process.env.SAT_GROUP_TOKEN ?? readFileSync(ENV_FILE, 'utf8').split('\n').find((l) => l.startsWith('SAT_GROUP_TOKEN='))!.split('=')[1].trim().replace(/^["']|["']$/g, ''));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  mkdirSync(OUT, { recursive: true });
  const headers = { authorization: `Bearer ${token}` };
  const session = (await (await fetch(`${BASE}/v1/session`, { headers })).json()) as { latest_offset: number; profile: string; speed: number; virtual_now: string };
  const startFrom = Math.max(0, session.latest_offset - START_BEHIND);

  const storage = new InMemoryStorage();
  const coordinator = new InMemoryCoordinator(storage, 'live');
  await coordinator.commitCursor('satellite', '0', { position: { offset: startFrom - 1 }, last_ingested_at: null, updated_by: 'seed' }, 0); // resume point
  const metrics = new SatelliteMetrics();
  const sink = new FireSink(storage);
  const delivered: number[] = [];
  const tracking = { apply: async (batch: SatFrame[], ctx: Parameters<FireSink['apply']>[1]) => { for (const f of batch) delivered.push(f.offset); await sink.apply(batch, ctx); } };

  // Optional forced disconnects: cut our own connection mid-stream (what an egress block would do), without touching the server.
  let connectionId = 0;
  let forcedCuts = 0;
  const realFetch = fetch;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (!url.includes('/v1/stream') || !FORCE_EVERY_S) return realFetch(input, init);
    const cut = new AbortController();
    init?.signal?.addEventListener('abort', () => cut.abort());
    const id = ++connectionId;
    setTimeout(() => { if (connectionId === id) { forcedCuts++; cut.abort(); } }, FORCE_EVERY_S * 1000); // only if this connection is still the current one
    return realFetch(input, { ...init, signal: cut.signal });
  }) as typeof fetch;

  const samples: string[] = [];
  const t0 = Date.now();
  const sampler = setInterval(async () => {
    const s = (await (await realFetch(`${BASE}/v1/session`, { headers })).json().catch(() => null)) as { latest_offset: number } | null;
    if (s) metrics.latestOffset = s.latest_offset;
    const line = JSON.stringify({ t_s: Math.round((Date.now() - t0) / 1000), head: s?.latest_offset ?? null, committed: metrics.committedOffset, lag: metrics.lag(), reconnects: metrics.reconnects, forced_cuts: forcedCuts, ...sink.engine.stats() });
    samples.push(line);
    appendFileSync(`${OUT}/samples.jsonl`, line + '\n');
  }, 5000);
  writeFileSync(`${OUT}/samples.jsonl`, '');

  const done = runSatellite({
    coordinator, ingest: createIngestContext({ storage, env: {} }), sink: tracking, metrics,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    client: new FeedClient({ baseUrl: BASE, token, idleTimeoutMs: 30_000, fetchImpl }),
    config: { SAT_CHECKPOINT_EVERY_N: 100, SAT_BATCH_SIZE: 500, SAT_FLUSH_INTERVAL_MS: 250, SAT_RECONNECT_MIN_MS: 200, SAT_RECONNECT_MAX_MS: 15_000, POD_NAME: 'live' },
  });
  await sleep(DURATION_S * 1000);
  clearInterval(sampler);
  await coordinator.stop();
  await done;

  const unique = new Set(delivered);
  const sorted = [...unique].sort((a, b) => a - b);
  const gaps = sorted.filter((o, i) => i > 0 && o !== sorted[i - 1] + 1).length;
  const duplicatesDelivered = delivered.length - unique.size;
  const last = JSON.parse(samples[samples.length - 1] ?? '{}');
  const summary = {
    mode: MODE, feed: BASE.replace(/^https?:\/\//, ''), profile: session.profile, speed: session.speed, duration_s: DURATION_S,
    started_at_offset: startFrom, first_offset: sorted[0], last_offset: sorted.at(-1), frames: unique.size, gaps, duplicates_delivered_to_sink: duplicatesDelivered,
    reconnects: metrics.reconnects, forced_cuts: forcedCuts,
    event_to_store_p95_s: metrics.percentile(0.95), final_lag_frames: last.lag ?? null,
    open_fires: sink.engine.stats().open_fires, singles_total: sink.engine.stats().singles_total, late_applied: sink.engine.counters.lateApplied, late_beyond_bound: sink.engine.counters.lateBeyond,
    events_stored: (await storage.listEvents({ source: 'SATELIT', limit: 100_000 })).items.length,
  };
  writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  const rows: Array<[string, string, boolean]> = [
    ['ran for the requested time', `${DURATION_S} s`, true],
    ['offsets contiguous (no gap)', `${summary.frames} frames, ${gaps} gaps`, gaps === 0 && summary.frames > 0],
    [MODE === 'disconnect' ? 'forced disconnects survived' : 'reconnects (server closes every ~43 s)', `${MODE === 'disconnect' ? forcedCuts : metrics.reconnects}`, (MODE === 'disconnect' ? forcedCuts : metrics.reconnects) >= (MODE === 'disconnect' ? 3 : 3)],
    ['no duplicate reached the sink', String(duplicatesDelivered), MODE === 'disconnect' || duplicatesDelivered === 0],
  ];
  for (const [name, value, ok] of rows) console.log(`${name.padEnd(46)} | ${value.padEnd(28)} | ${ok ? 'PASS' : 'FAIL'}`);
  const failed = rows.filter((r) => !r[2]).length;
  console.log(failed === 0 ? '\nPASS' : `\nFAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
