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
import { StorageCanonicalStore, leaseNameFor } from './storage/storage-canonical-store';
import { createStorageFromEnv, startMembershipLoop, startRepairLoop } from '../../../shared-types/src/ring';
import { registerPlacementRoute } from './audit/placement-route';
import { registerAudit } from './audit/audit-router';
import { registerAnalyticsRoutes } from './analytics/analytics-routes';
import { notifierDeliveriesProvider } from './audit/critical-deliveries-provider';
import { createIngestContext } from './ingest/context';
import { PantaiPoller } from './sources/pantai-client';
import { mountIngest } from './ingest/wiring';
import { registerStorageGateway } from './storage/gateway-route';
import { coordinatorFromEnv } from '../../../shared-types/src/coordination/factory';
import { InMemoryCoordinator } from './coordination/in-memory-coordinator';
import { METRICS, setGauge } from './resilience/obs';
import { LEADER_NAMES, type Coordinator, type Parker, type StorageClient } from '../../../shared-types/src/m2/types';
import type { FastifyInstance } from 'fastify';

// bnpb_parked_messages{status,reason_code}: what is parked right now (dashboard P3). Labels that dropped to zero are written as 0 so the series does not freeze at its last value.
const parkedSeen = new Set<string>();
async function syncParkedGauge(parker: Parker): Promise<void> {
  const counts = new Map<string, number>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await parker.listUnprocessed({ limit: 1000, cursor });
    for (const m of r.items) { const k = `${m.status}|${m.reason_code}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
    cursor = r.next_cursor ?? undefined;
    if (!cursor) break;
  }
  for (const k of parkedSeen) if (!counts.has(k)) counts.set(k, 0);
  for (const [k, n] of counts) { parkedSeen.add(k); const [status, reason_code] = k.split('|'); setGauge(METRICS.parked, { status, reason_code }, n); }
}

async function syncAggregatorMetrics(storage: StorageClient | null, coordinator: Coordinator | null, parker?: Parker): Promise<void> {
  if (parker) await syncParkedGauge(parker).catch(() => undefined);
  if (coordinator) {
    for (const name of Object.values(LEADER_NAMES)) {
      setGauge(METRICS.leader, { name }, coordinator.isLeader(name) ? 1 : 0);
    }
  }
  if (storage) {
    try {
      const rs = await storage.ringStatus();
      setGauge(METRICS.ringEpoch, {}, rs.epoch);
      for (const u of rs.units) {
        setGauge(METRICS.unitUp, { unit: u.unit, node: u.node }, u.state === 'STABLE' ? 1 : 0);
        setGauge(METRICS.unitKeys, { unit: u.unit, node: u.node }, u.keys);
        setGauge(METRICS.unitWrites, { unit: u.unit, node: u.node }, u.writes_total);
      }
    } catch {
      // Non-fatal during scrape
    }
  }
}

async function main(): Promise<void> {
  const logger = createLogger(SERVICE_NAME);
  // STORAGE_UNITS / STORAGE_UNITS_DNS selects the replicated ring (M2); otherwise the single PostgreSQL store (M1) is used.
  const useRing = Boolean(process.env.STORAGE_UNITS || process.env.STORAGE_UNITS_DNS || process.env.STORAGE_UNITS_FILE);
  const storage = useRing ? await createStorageFromEnv() : null;
  if (!storage && !config.databaseUrl) throw new Error('set STORAGE_UNITS(_DNS) or DATABASE_URL');
  const podName = process.env.POD_NAME ?? 'aggregator-local';
  const coordinator: Coordinator | null = storage ? (coordinatorFromEnv(storage, podName) ?? new InMemoryCoordinator(storage, podName)) : null;
  const store: CanonicalStore = storage
    ? new StorageCanonicalStore({ storage, fence: (source) => coordinator?.currentFence(leaseNameFor(source)) ?? 1 })
    : new PostgresCanonicalStore(config.databaseUrl!);
  await store.init();
  const stopRepair = storage ? startRepairLoop(storage, config.storageRepairIntervalMs, (err) => logger.error({ err: String(err) }, 'ring repair failed')) : null;
  // One ingest context shared by the pollers (park bad responses/items) and the Audit/replay routes (read what was parked).
  const ingest = storage ? createIngestContext({ storage }) : undefined;
  // New storage units that appear in DNS join the live ring (the repair loop above then fills them); none is ever removed automatically.
  const stopMembership = storage ? startMembershipLoop(storage, config.storageMembershipIntervalMs, process.env, (added) => logger.info({ units: added }, 'storage unit(s) joined the ring'), (err) => logger.warn({ err: String(err) }, 'storage membership check failed')) : null;
  const publisher = new RabbitMqEventPublisher({ url: config.rabbitmqUrl, logger });
  await publisher.start();
  const dispatcher = new OutboxDispatcher(storage ?? store, publisher, logger, config.outboxDispatchIntervalMs);
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
  let draining = false;
  const extras = storage
    ? (a: FastifyInstance) => {
        const wiring = mountIngest(a, { storage, internalServiceKey: config.internalServiceKey, ingest });
        registerAudit(a, { storage, providers: { ...wiring.providers, ...(config.notifierBaseUrl ? { criticalDeliveries: notifierDeliveriesProvider(config.notifierBaseUrl) } : {}) }, auditToken: config.auditToken });
        registerAnalyticsRoutes(a, { storage, internalServiceKey: config.internalServiceKey });
        registerPlacementRoute(a, storage);
        registerStorageGateway(a, storage, config.internalServiceKey);
      }
    : undefined;
  const app = buildApp(logger, {
    store,
    internalServiceKey: config.internalServiceKey,
    readinessCheck: () => !draining,
    onMetricsScrape: () => syncAggregatorMetrics(storage, coordinator, ingest?.parker),
    extras,
  });

  const shutdown = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    const drainSec = Number(process.env.PRESTOP_DRAIN_SECONDS ?? 0);
    if (drainSec > 0) {
      await new Promise((r) => setTimeout(r, drainSec * 1000));
    }
    scheduler.stop();
    pantai?.stop();
    await coordinator?.stop();
    stopRepair?.();
    stopMembership?.();
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
  // Sensor Pantai (Problem 5): fenced leader poller on the 'pantai' lease; needs the ring (events, outbox, parker) and a coordinator.
  const pantai = storage && coordinator && ingest && config.pantaiBaseUrl && config.pantaiAuthToken
    ? new PantaiPoller({
        baseUrl: config.pantaiBaseUrl, authToken: config.pantaiAuthToken, instanceId: podName,
        pollIntervalMs: config.pantaiPollIntervalMs, timeoutMs: config.pantaiTimeoutMs, maxStalenessSeconds: config.pantaiMaxStalenessS,
        storage, coordinator, parker: ingest.parker, criticalPublisher: publisher, syncState: store,
      })
    : null;
  if (pantai) void pantai.start().catch((err) => logger.error({ err: String(err) }, 'sensor-pantai poller stopped'));
  dispatcher.start();
  scheduler.start();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
