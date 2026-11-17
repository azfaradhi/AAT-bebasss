import type { Channel } from 'amqplib';
import { BROKER } from '../../../../shared-types/src/m2/types';

export const EXCHANGE_NAME = BROKER.hazardExchange;
export const CRITICAL_ALERTS_QUEUE = BROKER.criticalAlertsQueue;
export const FIELD_REPORTS_QUEUE = BROKER.fieldReportsQueue;
export const DLX_EXCHANGE = BROKER.deadLetterExchange;

export const QUORUM_QUEUE_ARGS = {
  'x-queue-type': 'quorum',
  'x-dead-letter-exchange': DLX_EXCHANGE,
} as const;

export async function assertTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EXCHANGE_NAME, 'fanout', { durable: true });
}

export async function assertM2QuorumQueues(channel: Channel): Promise<void> {
  await channel.assertExchange(DLX_EXCHANGE, 'fanout', { durable: true });
  await channel.assertQueue(CRITICAL_ALERTS_QUEUE, {
    durable: true,
    arguments: { ...QUORUM_QUEUE_ARGS },
  });
  await channel.assertQueue(FIELD_REPORTS_QUEUE, {
    durable: true,
    arguments: { ...QUORUM_QUEUE_ARGS },
  });
}
