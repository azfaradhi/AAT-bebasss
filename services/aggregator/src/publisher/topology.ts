import type { Channel } from 'amqplib';

export const EXCHANGE_NAME = 'hazard_events_exchange';

export async function assertTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EXCHANGE_NAME, 'fanout', { durable: true });
}
