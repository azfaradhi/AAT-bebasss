import { buildApp, SERVICE_NAME } from './app';
import { config } from './config';
import { createLogger } from './logger';
import { HttpAggregatorClient } from './clients/aggregator-client';
import { PriorityAdmissionController } from './middleware/admission';
import { storageFromEnvOrNull } from '../../../shared-types/src/ring/factory';
import { FieldReportStore } from '../../../shared-types/src/field-reports';

async function main(): Promise<void> {
  const logger = createLogger(SERVICE_NAME);
  const admissionController = new PriorityAdmissionController({
    maxInflight: config.admissionMaxInflight,
    lapanganReserved: config.admissionLapanganReserved,
    mediaMaxInflight: config.admissionMediaMaxInflight,
    retryAfterSeconds: config.admissionRetryAfterSeconds,
  });

  const storage = await storageFromEnvOrNull();
  const app = buildApp(logger, {
    clientJwtSecret: config.clientJwtSecret,
    jwtClockToleranceSeconds: config.jwtClockToleranceSeconds,
    admissionController,
    fieldReportStore: storage ? new FieldReportStore(storage) : undefined,
    ops: { aggregatorBaseUrl: config.aggregatorBaseUrl, internalServiceKey: config.internalServiceKey, advisorBaseUrl: config.advisorBaseUrl },
    aggregatorClient: new HttpAggregatorClient(
      config.aggregatorBaseUrl,
      config.internalServiceKey,
      logger,
      config.aggregatorRequestTimeoutMs,
      { ttlMs: config.clientCacheTtlMs, staleMaxAgeMs: config.clientStaleMaxAgeMs },
    ),
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
