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
import { PostgresCanonicalStore } from './storage/canonical-store';

async function main(): Promise<void> {
  const logger = createLogger(SERVICE_NAME);
  const store = new PostgresCanonicalStore(config.databaseUrl);
  await store.init();
  const publisher = new RabbitMqEventPublisher({ url: config.rabbitmqUrl, logger });
  await publisher.start();
  const dispatcher = new OutboxDispatcher(store, publisher, logger);
  const scheduler = new PollingScheduler({
    logger,
    intervalMs: config.pollIntervalMs,
    lookbackMs: config.pollLookbackMs,
    store,
    bmkg: new BmkgClient({
      baseUrl: config.bmkgBaseUrl,
      apiKey: config.bmkgApiKey,
      timeoutMs: config.sourceRequestTimeoutMs,
      logger,
    }),
    pvmbg: new PvmbgClient({
      baseUrl: config.pvmbgBaseUrl,
      accessToken: config.pvmbgAccessToken,
      timeoutMs: config.sourceRequestTimeoutMs,
      logger,
      circuitBreaker: new CircuitBreaker(config.circuitBreakerFailureThreshold, config.circuitBreakerCooldownMs),
      limiter: new ConcurrencyLimiter(config.pvmbgMaxConcurrentCalls),
    }),
  });
  const app = buildApp(logger, { store, internalServiceKey: config.internalServiceKey });

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    await dispatcher.stop();
    await publisher.close();
    await store.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: '0.0.0.0' });
  dispatcher.start();
  scheduler.start();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
