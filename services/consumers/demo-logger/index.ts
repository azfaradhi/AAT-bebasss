import amqp from 'amqplib';
import pino from 'pino';

const EXCHANGE_NAME = 'hazard_events_exchange';
const QUEUE_NAME = 'demo_logger_queue';
const url = process.env.RABBITMQ_URL;
const logger = pino({ base: { service: 'demo-logger' }, messageKey: 'message' });

if (!url) throw new Error('RABBITMQ_URL must be configured');

async function main(brokerUrl: string): Promise<void> {
  const connection = await amqp.connect(brokerUrl);
  const channel = await connection.createChannel();
  await channel.assertExchange(EXCHANGE_NAME, 'fanout', { durable: true });
  await channel.assertQueue(QUEUE_NAME, { durable: true });
  await channel.bindQueue(QUEUE_NAME, EXCHANGE_NAME, '');
  await channel.prefetch(1);

  logger.info({ exchange: EXCHANGE_NAME, queue: QUEUE_NAME }, 'bound, waiting for events');
  await channel.consume(
    QUEUE_NAME,
    (msg) => {
      if (!msg) return;
      const message = JSON.parse(msg.content.toString('utf8'));
      logger.info(
        { hazard_id: message.payload?.hazard_id, severity: message.payload?.severity, correlation_id: message.correlation_id },
        'received hazard event',
      );
      channel.ack(msg);
    },
    { noAck: false },
  );
}

main(url).catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'demo-logger fatal');
  process.exit(1);
});
