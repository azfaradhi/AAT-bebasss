// Run inside a one-off Compose container: ... run --rm --no-deps -T aggregator node -
// This is an independent test subscriber; it does not import or modify producer code.
const amqp = require('amqplib');
const { randomUUID } = require('node:crypto');

async function main() {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  const channel = await connection.createChannel();
  const queue = `audit_third_consumer_${randomUUID().replace(/-/g, '')}`;
  try {
    await channel.assertExchange('hazard_events_exchange', 'fanout', { durable: true });
    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, 'hazard_events_exchange', '');

    const event = await Promise.race([
      new Promise((resolve, reject) => {
        channel.consume(queue, (message) => {
          if (!message) return;
          try {
            const envelope = JSON.parse(message.content.toString('utf8'));
            channel.ack(message);
            resolve(envelope);
          } catch (err) {
            reject(err);
          }
        }, { noAck: false }).catch(reject);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('No event received in 45 seconds')), 45000)),
    ]);
    if (event.event_type !== 'HazardEventCreated' || !event.payload?.hazard_id) {
      throw new Error('New consumer received a malformed event');
    }
    process.stdout.write(JSON.stringify({ received: true, queue, hazard_id: event.payload.hazard_id }) + '\n');
  } finally {
    await channel.deleteQueue(queue);
    await channel.close();
    await connection.close();
  }
}

main().catch((err) => { process.stderr.write(String(err) + '\n'); process.exitCode = 1; });
