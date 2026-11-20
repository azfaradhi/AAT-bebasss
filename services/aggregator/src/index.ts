import { buildApp, SERVICE_NAME } from './app';
import { config } from './config';
import { createLogger } from './logger';
import { PollingScheduler } from './polling/scheduler';
import { RabbitMqEventPublisher } from './publisher/event-publisher';
import { OutboxDispatcher } from './publisher/outbox-dispatcher';
import { CircuitBreaker } from './resilience/circuit-breaker';
import { ConcurrencyLimiter } from './resilience/concurrency-limiter';
import { BmkgClient } from './sources/bmkg-client';
import { PvmbgClient } from './sources/pvmbg-client';
import { PostgresCanonicalStore, type CanonicalStore } from './storage/canonical-store';
import { StorageCanonicalStore } from './storage/storage-canonical-store';
import { createStorageFromEnv, startRepairLoop } from '../../../shared-types/src/ring';
import { registerAudit } from './audit/audit-router';
import { registerAnalyticsRoutes } from './analytics/analytics-routes';
import { createIngestContext } from './ingest/context';
import { mountIngest } from './ingest/wiring';
import { registerStorageGateway } from './storage/gateway-route';
import { coordinatorFromEnv } from '../../../shared-types/src/coordination/factory';
import { InMemoryCoordinator } from './coordination/in-memory-coordinator';
import type { Coordinator } from '../../../shared-types/src/m2/types';
import type { FastifyInstance } from 'fastify';

async function main(): Promise<void> {
  const logger = createLogger(SERVICE_NAME);
  // STORAGE_UNITS / STORAGE_UNITS_DNS selects the replicated ring (M2); otherwise the single PostgreSQL store (M1) is used.
  const useRing = Boolean(process.env.STORAGE_UNITS || process.env.STORAGE_UNITS_DNS);
  const storage = useRing ? await createStorageFromEnv() : null;
  if (!storage && !config.databaseUrl) throw new Error('set STORAGE_UNITS(_DNS) or DATABASE_URL');
  const podName = process.env.POD_NAME ?? 'aggregator-local';
  const coordinator: Coordinator | null = storage ? (coordinatorFromEnv(storage, podName) ?? new InMemoryCoordinator(storage, podName)) : null;
  const store: CanonicalStore = storage
    ? new StorageCanonicalStore({ storage, fence: (source) => coordinator?.currentFence(source.toLowerCase()) ?? 1 })
    : new PostgresCanonicalStore(config.databaseUrl!);
  await store.init();
  const stopRepair = storage ? startRepairLoop(storage, config.storageRepairIntervalMs, (err) => logger.error({ err: String(err) }, 'ring repair failed')) : null;
  // One ingest context shared by the pollers (park bad responses/items) and the Audit/replay routes (read what was parked).
  const ingest = storage ? createIngestContext({ storage }) : undefined;
  const publisher = new RabbitMqEventPublisher({ url: config.rabbitmqUrl, logger });
  await publisher.start();
  const dispatcher = new OutboxDispatcher(storage ?? store, publisher, logger);
  const scheduler = new PollingScheduler({
    logger,
    isLeader: coordinator ? (source) => coordinator.isLeader(source.toLowerCase()) : undefined,
    intervalMs: config.pollIntervalMs,
    lookbackMs: config.pollLookbackMs,
    store,
    bmkg: new BmkgClient({
      baseUrl: config.bmkgBaseUrl,
      apiKey: config.bmkgApiKey,
      timeoutMs: config.sourceRequestTimeoutMs,
      logger,
      ingest,
    }),
    pvmbg: new PvmbgClient({
      baseUrl: config.pvmbgBaseUrl,
      accessToken: config.pvmbgAccessToken,
      timeoutMs: config.sourceRequestTimeoutMs,
      logger,
      circuitBreaker: new CircuitBreaker(config.circuitBreakerFailureThreshold, config.circuitBreakerCooldownMs),
      limiter: new ConcurrencyLimiter(config.pvmbgMaxConcurrentCalls),
      ingest,
    }),
  });
  const extras = storage
    ? (a: FastifyInstance) => {
        const wiring = mountIngest(a, { storage, internalServiceKey: config.internalServiceKey, ingest });
        registerAudit(a, { storage, providers: wiring.providers, auditToken: config.auditToken });
        registerAnalyticsRoutes(a, { storage, internalServiceKey: config.internalServiceKey });
        registerStorageGateway(a, storage, config.internalServiceKey);
      }
    : undefined;
  const app = buildApp(logger, { store, internalServiceKey: config.internalServiceKey, extras });

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    await coordinator?.stop();
    stopRepair?.();
    await dispatcher.stop();
    await publisher.close();
    await store.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: '0.0.0.0' });
  // Each source has its own lease; holding it is all the leader function does, the scheduler checks isLeader before every tick.
  for (const name of ['bmkg', 'pvmbg']) {
    void coordinator?.runAsLeader(name, ({ signal }) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve())));
  }
  dispatcher.start();
  scheduler.start();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
