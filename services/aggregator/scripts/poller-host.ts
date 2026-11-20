// Dev host: the Aggregator's BMKG/PVMBG poller path (ring store, Lease leader per source, defensive ingest) without RabbitMQ or HTTP routes.
import { coordinatorFromEnv } from '../../../shared-types/src/coordination/factory';
import { createStorageFromEnv } from '../../../shared-types/src/ring';
import { InMemoryCoordinator } from '../src/coordination/in-memory-coordinator';
import { createIngestContext } from '../src/ingest/context';
import { createLogger } from '../src/logger';
import { PollingScheduler } from '../src/polling/scheduler';
import { CircuitBreaker } from '../src/resilience/circuit-breaker';
import { ConcurrencyLimiter } from '../src/resilience/concurrency-limiter';
import { BmkgClient } from '../src/sources/bmkg-client';
import { PvmbgClient } from '../src/sources/pvmbg-client';
import { StorageCanonicalStore } from '../src/storage/storage-canonical-store';

async function main(): Promise<void> {
  const logger = createLogger('aggregator-poller-host');
  const podName = process.env.POD_NAME ?? 'poller-host';
  const storage = await createStorageFromEnv();
  const coordinator = coordinatorFromEnv(storage, podName) ?? new InMemoryCoordinator(storage, podName);
  const store = new StorageCanonicalStore({ storage, fence: (source) => coordinator.currentFence(source.toLowerCase()) });
  const ingest = createIngestContext({ storage });
  const timeoutMs = Number(process.env.SOURCE_TIMEOUT_MS ?? 3000);
  const scheduler = new PollingScheduler({
    logger, store, intervalMs: Number(process.env.POLL_INTERVAL_MS ?? 2000), lookbackMs: Number(process.env.POLL_LOOKBACK_MS ?? 0),
    isLeader: (source) => coordinator.isLeader(source.toLowerCase()),
    bmkg: new BmkgClient({ baseUrl: process.env.BMKG_BASE_URL!, apiKey: process.env.BMKG_API_KEY!, timeoutMs, logger, ingest }),
    pvmbg: new PvmbgClient({ baseUrl: process.env.PVMBG_BASE_URL!, accessToken: process.env.PVMBG_ACCESS_TOKEN!, timeoutMs, logger, ingest, circuitBreaker: new CircuitBreaker(5, 5000), limiter: new ConcurrencyLimiter(5) }),
  });
  for (const name of ['bmkg', 'pvmbg']) void coordinator.runAsLeader(name, ({ signal }) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve())));
  scheduler.start();
  process.on('SIGTERM', async () => { scheduler.stop(); await coordinator.stop(); process.exit(0); });
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exit(1); });
