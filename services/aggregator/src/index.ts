import { buildApp, SERVICE_NAME } from './app';
import { config } from './config';
import { createLogger } from './logger';
import { PollingScheduler } from './polling/scheduler';
import { createStubSourceClient } from './sources/stub-source-client';

async function main(): Promise<void> {
  const logger = createLogger(SERVICE_NAME);
  const scheduler = new PollingScheduler({
    logger,
    intervalMs: config.pollIntervalMs,
    sources: [createStubSourceClient('BMKG-stub'), createStubSourceClient('PVMBG-stub')],
  });
  const app = buildApp(logger);

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: '0.0.0.0' });
  scheduler.start();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
