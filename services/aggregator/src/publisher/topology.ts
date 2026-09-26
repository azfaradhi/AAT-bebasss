import type { Channel } from 'amqplib';

// Broker topology. Consumers keep their own copy of these names: no runtime code is shared across services.
export const EXCHANGE_NAME = 'hazard_events_exchange';
export const CONSUMER_QUEUES = ['dashboard_updater_queue', 'notifier_queue'] as const;

// Idempotent: safe to run on every boot. Arguments must match what consumers declare, or the broker rejects with PRECONDITION_FAILED.
export async function assertTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EXCHANGE_NAME, 'fanout', { durable: true });
  for (const queue of CONSUMER_QUEUES) {
    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, EXCHANGE_NAME, '');
  }
}
