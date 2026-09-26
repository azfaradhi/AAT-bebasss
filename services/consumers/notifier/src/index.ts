import { buildApp, SERVICE_NAME } from './app';
import { config } from './config';
import { HazardEventConsumer } from './consumer';
import { SeenSet } from './dedup';
import { createLogger } from './logger';
import { createNotifierSideEffect } from './sideEffect';

async function main(): Promise<void> {
  const logger = createLogger(SERVICE_NAME);
  const consumer = new HazardEventConsumer({
    url: config.rabbitmqUrl,
    logger,
    handler: { seen: new SeenSet(), sideEffect: createNotifierSideEffect(logger), logger },
  });
  const app = buildApp(logger, () => consumer.isConnected());

  const shutdown = async (): Promise<void> => {
    await consumer.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: '0.0.0.0' });
  await consumer.start();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
