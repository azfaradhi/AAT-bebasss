import type { Channel } from 'amqplib';

// The producer owns only the exchange. Each consumer declares and binds its own queue.
export const EXCHANGE_NAME = 'hazard_events_exchange';

// Idempotent: safe to run on every boot, regardless of which consumers exist.
export async function assertTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EXCHANGE_NAME, 'fanout', { durable: true });
}
