// Dev host: the Aggregator's ring-facing routes (Audit, analytics, ingest ops, storage gateway, metrics, readiness drain, and optional Lease-coordinated BMKG/PVMBG pollers) without RabbitMQ.
import { coordinatorFromEnv } from '../../../shared-types/src/coordination/factory';
import { LEADER_NAMES } from '../../../shared-types/src/m2/types';
import { createStorageFromEnv, startMembershipLoop, startRepairLoop } from '../../../shared-types/src/ring';
import { buildApp } from '../src/app';
import { InMemoryCoordinator } from '../src/coordination/in-memory-coordinator';
import { createIngestContext } from '../src/ingest/context';
import { createLogger } from '../src/logger';
import { PollingScheduler } from '../src/polling/scheduler';
import { CircuitBreaker } from '../src/resilience/circuit-breaker';
import { ConcurrencyLimiter } from '../src/resilience/concurrency-limiter';
import { METRICS, setGauge } from '../src/resilience/obs';
import { BmkgClient } from '../src/sources/bmkg-client';
import { PvmbgClient } from '../src/sources/pvmbg-client';
import { StorageCanonicalStore } from '../src/storage/storage-canonical-store';
import { registerAnalyticsRoutes } from '../src/analytics/analytics-routes';
import { registerPlacementRoute } from '../src/audit/placement-route';
import { registerAudit } from '../src/audit/audit-router';
import { mountIngest } from '../src/ingest/wiring';
import { registerStorageGateway } from '../src/storage/gateway-route';

async function main(): Promise<void> {
  const key = process.env.INTERNAL_SERVICE_KEY ?? 'ik';
  const podName = process.env.POD_NAME ?? process.env.HOSTNAME ?? 'ring-host';
  const storage = await createStorageFromEnv();
  const coordinator = coordinatorFromEnv(storage, podName) ?? new InMemoryCoordinator(storage, podName);
  const stopRepair = startRepairLoop(storage, Number(process.env.STORAGE_REPAIR_INTERVAL_MS ?? 5000));
  const stopMembership = startMembershipLoop(storage, Number(process.env.STORAGE_MEMBERSHIP_INTERVAL_MS ?? 5000));
  const store = new StorageCanonicalStore({
    storage,
    fence: (source) => coordinator.currentFence(source.toLowerCase()) ?? 1,
    listCacheMs: Number(process.env.LIST_CACHE_MS ?? 1000),
  });
  const ingest = createIngestContext({ storage });
  let draining = false;

  const syncMetrics = async () => {
    for (const name of Object.values(LEADER_NAMES)) {
      setGauge(METRICS.leader, { name }, coordinator.isLeader(name) ? 1 : 0);
    }
    try {
      const rs = await storage.ringStatus();
      setGauge(METRICS.ringEpoch, {}, rs.epoch);
      for (const u of rs.units) {
        setGauge(METRICS.unitUp, { unit: u.unit, node: u.node }, u.state === 'STABLE' ? 1 : 0);
        setGauge(METRICS.unitKeys, { unit: u.unit, node: u.node }, u.keys);
        setGauge(METRICS.unitWrites, { unit: u.unit, node: u.node }, u.writes_total);
      }
    } catch { /* ignore */ }
  };

  const logger = createLogger('ring-host', 'warn');
  const app = buildApp(logger, {
    store,
    internalServiceKey: key,
    readinessCheck: () => !draining,
    onMetricsScrape: syncMetrics,
    extras: (a) => {
      const wiring = mountIngest(a, { storage, internalServiceKey: key, ingest });
      registerAudit(a, { storage, providers: wiring.providers, auditToken: process.env.AUDIT_TOKEN ?? 'audit-secret' });
      registerAnalyticsRoutes(a, { storage, internalServiceKey: key });
      registerPlacementRoute(a, storage);
      registerStorageGateway(a, storage, key);
      a.post<{ Body?: { draining?: boolean } }>('/internal/admin/drain', async (req) => {
        draining = req.body?.draining ?? true;
        return { instance: podName, draining };
      });
    },
  });

  let scheduler: PollingScheduler | null = null;
  if (process.env.BMKG_BASE_URL && process.env.PVMBG_BASE_URL) {
    const timeoutMs = Number(process.env.SOURCE_TIMEOUT_MS ?? 3000);
    scheduler = new PollingScheduler({
      logger,
      store,
      intervalMs: Number(process.env.POLL_INTERVAL_MS ?? 2000),
      lookbackMs: Number(process.env.POLL_LOOKBACK_MS ?? 60000),
      isLeader: (source) => coordinator.isLeader(source.toLowerCase()),
      bmkg: new BmkgClient({ baseUrl: process.env.BMKG_BASE_URL, apiKey: process.env.BMKG_API_KEY ?? 'bk', timeoutMs, logger, ingest }),
      pvmbg: new PvmbgClient({
        baseUrl: process.env.PVMBG_BASE_URL,
        accessToken: process.env.PVMBG_ACCESS_TOKEN ?? 'pt',
        timeoutMs,
        logger,
        ingest,
        circuitBreaker: new CircuitBreaker(5, 5000),
        limiter: new ConcurrencyLimiter(5),
      }),
    });
    for (const name of ['bmkg', 'pvmbg']) {
      void coordinator.runAsLeader(name, ({ signal }) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve())));
    }
    scheduler.start();
  }

  const shutdown = async () => {
    if (draining && Number(process.env.PRESTOP_DRAIN_SECONDS ?? 0) === 0) {
      // already draining
    }
    draining = true;
    const drainMs = Number(process.env.PRESTOP_DRAIN_MS ?? Number(process.env.PRESTOP_DRAIN_SECONDS ?? 0) * 1000);
    if (drainMs > 0) await new Promise((r) => setTimeout(r, drainMs));
    scheduler?.stop();
    stopRepair();
    stopMembership();
    await coordinator.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: Number(process.env.AGGREGATOR_PORT ?? 8090), host: '0.0.0.0' });
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exit(1); });
