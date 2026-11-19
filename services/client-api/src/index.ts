import { buildApp, SERVICE_NAME } from './app';
import { config } from './config';
import { createLogger } from './logger';
import { HttpAggregatorClient } from './clients/aggregator-client';
import { PriorityAdmissionController } from './middleware/admission';

async function main(): Promise<void> {
  const logger = createLogger(SERVICE_NAME);
  const admissionController = new PriorityAdmissionController({
    maxInflight: config.admissionMaxInflight,
    lapanganReserved: config.admissionLapanganReserved,
    mediaMaxInflight: config.admissionMediaMaxInflight,
    retryAfterSeconds: config.admissionRetryAfterSeconds,
  });

  const app = buildApp(logger, {
    clientJwtSecret: config.clientJwtSecret,
    jwtClockToleranceSeconds: config.jwtClockToleranceSeconds,
    admissionController,
    ops: { aggregatorBaseUrl: config.aggregatorBaseUrl, internalServiceKey: config.internalServiceKey, advisorBaseUrl: config.advisorBaseUrl },
    aggregatorClient: new HttpAggregatorClient(
      config.aggregatorBaseUrl,
      config.internalServiceKey,
      logger,
      config.aggregatorRequestTimeoutMs,
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
