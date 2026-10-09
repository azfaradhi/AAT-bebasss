import amqp from 'amqplib';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from './config';
import { assertTopology, QUEUE_NAME } from './topology';

async function initialize(): Promise<void> {
  const connection = await amqp.connect(config.rabbitmqUrl);
  try {
    const channel = await connection.createChannel();
    try {
      await assertTopology(channel);
    } finally {
      await channel.close();
    }
  } finally {
    await connection.close();
  }
}

async function main(): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await initialize();
      process.stdout.write(JSON.stringify({
        level: 'info', timestamp: new Date().toISOString(), service: 'dashboard-queue-init',
        queue: QUEUE_NAME, message: 'queue bound',
      }) + '\n');
      return;
    } catch (err) {
      if (attempt === 30) throw err;
      await delay(1000);
    }
  }
}

main().catch((err) => {
  process.stderr.write(JSON.stringify({
    level: 'error', timestamp: new Date().toISOString(), service: 'dashboard-queue-init',
    queue: QUEUE_NAME, err: err instanceof Error ? err.message : String(err),
    message: 'queue initialization failed',
  }) + '\n');
  process.exitCode = 1;
});
