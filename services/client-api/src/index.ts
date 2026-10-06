import { buildApp, SERVICE_NAME } from './app';
import { config } from './config';
import { createLogger } from './logger';
import { HttpAggregatorClient } from './clients/aggregator-client';

async function main(): Promise<void> {
  const logger = createLogger(SERVICE_NAME);
  const app = buildApp(logger, {
    clientJwtSecret: config.clientJwtSecret,
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
