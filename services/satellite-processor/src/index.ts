import pino from 'pino';
import { coordinatorFromEnv } from '../../../shared-types/src/coordination/factory';
import { storageFromEnvOrNull } from '../../../shared-types/src/ring/factory';
import type { StorageClient } from '../../../shared-types/src/m2/types';
import { loggerOptions } from '../../../shared-types/src/obs-lite';
import { createIngestContext } from '../../aggregator/src/ingest/context';
import { InMemoryCoordinator } from '../test-support/contract-fakes/fakes/in-memory-coordinator';
import { InMemoryStorage } from '../test-support/contract-fakes/fakes/in-memory-storage';
import { loadConfig } from './config';
import { FeedClient } from './feed-client';
import { SatelliteMetrics } from './metrics';
import { runSatellite } from './processor';
import { buildServer } from './server';
import { FireSink } from './fire/fire-sink';

function lateMetrics(sink: FireSink): string {
  const c = sink.engine.counters;
  return [
    `bnpb_sat_late_applied_total ${c.lateApplied}`,
    `bnpb_sat_late_beyond_bound_total ${c.lateBeyond}`,
    `bnpb_sat_frozen_ignored_total ${c.frozenIgnored}`,
    `bnpb_sat_finalized_fires_total ${c.finalizedFires}`,
    `bnpb_sat_open_fires ${sink.engine.fires.size}`,
    `bnpb_sat_detections_single ${sink.engine.singlesTotal()}`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = pino(loggerOptions('satellite-processor'));
  const metrics = new SatelliteMetrics();

  // The ring (directly or through the Aggregator gateway) when configured, otherwise in-memory; Kubernetes Lease coordinator in a cluster.
  const storage: StorageClient = (await storageFromEnvOrNull()) ?? new InMemoryStorage();
  const coordinator = coordinatorFromEnv(storage, config.POD_NAME) ?? new InMemoryCoordinator(storage, config.POD_NAME);
  const ingest = createIngestContext({ storage });
  const sink = new FireSink(storage, Date.now, config.SAT_ALLOWED_LATENESS_MIN * 60_000, config.SAT_WRITE_CONCURRENCY);
  const client = new FeedClient({ baseUrl: config.SAT_FEED_BASE_URL, token: config.SAT_GROUP_TOKEN, idleTimeoutMs: config.SAT_IDLE_TIMEOUT_MS });

  let ready = false;
  const server = buildServer(metrics, () => ready, () => ingest.metrics.render() + lateMetrics(sink), () => sink.engine.stats());
  await server.listen({ port: config.SATELLITE_PORT, host: '0.0.0.0' });

  const poll = setInterval(() => {
    void client.session().then((s) => { if (s) metrics.latestOffset = s.latest_offset; });
  }, config.SAT_SESSION_POLL_MS);
  poll.unref();

  const shutdown = async (): Promise<void> => {
    ready = false;
    clearInterval(poll);
    await coordinator.stop();
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  ready = true;
  await runSatellite({ coordinator, ingest, sink, config, client, metrics, logger });
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
