import type { Channel } from 'amqplib';
import { BROKER } from '../../../../shared-types/src/m2/types';

export const EXCHANGE_NAME = BROKER.hazardExchange;
export const QUEUE_NAME = 'notifier_queue';
export const CRITICAL_QUEUE_NAME = BROKER.criticalAlertsQueue;
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

export async function assertCriticalTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(DLX_EXCHANGE, 'fanout', { durable: true });
  await channel.assertQueue(CRITICAL_QUEUE_NAME, {
    durable: true,
    arguments: { ...QUORUM_QUEUE_ARGS },
  });
}
