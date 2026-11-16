import pino from 'pino';
import { createIngestContext } from '../../aggregator/src/ingest/context';
import { InMemoryCoordinator } from '../test-support/contract-fakes/fakes/in-memory-coordinator';
import { InMemoryStorage } from '../test-support/contract-fakes/fakes/in-memory-storage';
import { loadConfig } from './config';
import { FeedClient } from './feed-client';
import { SatelliteMetrics } from './metrics';
import { runSatellite } from './processor';
import { buildServer } from './server';
import { CollectingSink } from './sink';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = pino({ base: null, messageKey: 'message', formatters: { level: (label) => ({ level: label }) } });
  const metrics = new SatelliteMetrics();

  // Interim backends until Member 2's real StorageClient/Coordinator are wired; both sit behind the contract interfaces.
  const storage = new InMemoryStorage();
  const coordinator = new InMemoryCoordinator(storage, config.POD_NAME);
  const ingest = createIngestContext({ storage });
  const client = new FeedClient({ baseUrl: config.SAT_FEED_BASE_URL, token: config.SAT_GROUP_TOKEN, idleTimeoutMs: config.SAT_IDLE_TIMEOUT_MS });

  let ready = false;
  const server = buildServer(metrics, () => ready, () => ingest.metrics.render());
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
  await runSatellite({ coordinator, ingest, sink: new CollectingSink(), config, client, metrics, logger });
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
