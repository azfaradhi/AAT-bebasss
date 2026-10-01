// Ad-hoc third consumer, proving a new subscriber needs no publisher change. Not in docker-compose.yml;
// run manually: npx tsx index.ts
import amqp from 'amqplib';

const EXCHANGE_NAME = 'hazard_events_exchange';
const QUEUE_NAME = 'demo_logger_queue';
const url = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';

async function main(): Promise<void> {
  const connection = await amqp.connect(url);
  const channel = await connection.createChannel();
  await channel.assertExchange(EXCHANGE_NAME, 'fanout', { durable: true });
  await channel.assertQueue(QUEUE_NAME, { durable: true });
  await channel.bindQueue(QUEUE_NAME, EXCHANGE_NAME, '');
  await channel.prefetch(1);

  console.log(`demo-logger: bound to ${EXCHANGE_NAME} via ${QUEUE_NAME}, waiting for events...`);
  await channel.consume(
    QUEUE_NAME,
    (msg) => {
      if (!msg) return;
      const message = JSON.parse(msg.content.toString('utf8'));
      console.log(`demo-logger: received hazard_id=${message.payload?.hazard_id} severity=${message.payload?.severity}`);
      channel.ack(msg);
    },
    { noAck: false },
  );
}

main().catch((err) => {
  console.error('demo-logger fatal:', err);
  process.exit(1);
});
