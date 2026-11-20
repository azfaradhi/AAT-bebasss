// Dev host: the Aggregator's ring-facing routes (Audit, analytics, ingest ops, storage gateway) without RabbitMQ or the pollers.
import { createStorageFromEnv, startMembershipLoop, startRepairLoop } from '../../../shared-types/src/ring';
import { buildApp } from '../src/app';
import { createLogger } from '../src/logger';
import { StorageCanonicalStore } from '../src/storage/storage-canonical-store';
import { registerAnalyticsRoutes } from '../src/analytics/analytics-routes';
import { registerAudit } from '../src/audit/audit-router';
import { mountIngest } from '../src/ingest/wiring';
import { registerStorageGateway } from '../src/storage/gateway-route';

async function main(): Promise<void> {
  const key = process.env.INTERNAL_SERVICE_KEY ?? 'ik';
  const storage = await createStorageFromEnv();
  startRepairLoop(storage, Number(process.env.STORAGE_REPAIR_INTERVAL_MS ?? 5000));
  startMembershipLoop(storage, Number(process.env.STORAGE_MEMBERSHIP_INTERVAL_MS ?? 5000));
  // The same app the real Aggregator builds (internal hazards route + extras), over the ring store.
  const store = new StorageCanonicalStore({ storage });
  const app = buildApp(createLogger('ring-host', 'warn'), {
    store, internalServiceKey: key,
    extras: (a) => {
      const wiring = mountIngest(a, { storage, internalServiceKey: key });
      registerAudit(a, { storage, providers: wiring.providers, auditToken: process.env.AUDIT_TOKEN ?? 'audit-secret' });
      registerAnalyticsRoutes(a, { storage, internalServiceKey: key });
      registerStorageGateway(a, storage, key);
    },
  });
  await app.listen({ port: Number(process.env.AGGREGATOR_PORT ?? 8090), host: '0.0.0.0' });
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exit(1); });
