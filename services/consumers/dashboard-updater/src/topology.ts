import type { Channel } from 'amqplib';

// This consumer owns exactly one queue.
export const EXCHANGE_NAME = 'hazard_events_exchange';
export const QUEUE_NAME = 'dashboard_updater_queue';

// Idempotent, and never touches anyone else's queue: adding a consumer never requires touching the publisher or its siblings.
export async function assertTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EXCHANGE_NAME, 'fanout', { durable: true });
  await channel.assertQueue(QUEUE_NAME, { durable: true });
  await channel.bindQueue(QUEUE_NAME, EXCHANGE_NAME, '');
}
