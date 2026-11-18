import type { Channel } from 'amqplib';
import { BROKER } from '../../../../shared-types/src/m2/types';

export const EXCHANGE_NAME = BROKER.hazardExchange;
export const QUEUE_NAME = 'dashboard_updater_queue';
export const DLX_EXCHANGE = BROKER.deadLetterExchange;

export const QUORUM_QUEUE_ARGS = {
  'x-queue-type': 'quorum',
  'x-dead-letter-exchange': DLX_EXCHANGE,
} as const;

export async function assertTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EXCHANGE_NAME, 'fanout', { durable: true });
  await channel.assertQueue(QUEUE_NAME, { durable: true });
  await channel.bindQueue(QUEUE_NAME, EXCHANGE_NAME, '');
}
