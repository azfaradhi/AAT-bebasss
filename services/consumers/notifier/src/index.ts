import { buildApp, SERVICE_NAME } from './app';
import { config } from './config';
import { HazardEventConsumer } from './consumer';
import { CriticalDeliveryStore } from './critical-delivery-store';
import { SeenSet } from './dedup';
import { createLogger } from './logger';
import { createNotifierSideEffect } from './side-effect';

async function main(): Promise<void> {
  const logger = createLogger(SERVICE_NAME);
  const criticalDeliveries = new CriticalDeliveryStore();
  const consumer = new HazardEventConsumer({
    url: config.rabbitmqUrl,
    logger,
    handler: {
      seen: new SeenSet(),
      sideEffect: createNotifierSideEffect(logger),
      logger,
      criticalDeliveries,
    },
  });
  const app = buildApp(logger, () => consumer.isConnected(), criticalDeliveries);

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
