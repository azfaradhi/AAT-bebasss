import { describe, expect, it, vi } from 'vitest';
import { assertTopology, EXCHANGE_NAME, QUEUE_NAME } from './topology';

describe('notifier topology', () => {
  it('declares and binds only its own durable queue', async () => {
    const channel = {
      assertExchange: vi.fn().mockResolvedValue(undefined),
      assertQueue: vi.fn().mockResolvedValue(undefined),
      bindQueue: vi.fn().mockResolvedValue(undefined),
    };

    await assertTopology(channel as never);

    expect(channel.assertExchange).toHaveBeenCalledWith(EXCHANGE_NAME, 'fanout', { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledExactlyOnceWith(QUEUE_NAME, { durable: true });
    expect(channel.bindQueue).toHaveBeenCalledExactlyOnceWith(QUEUE_NAME, EXCHANGE_NAME, '');
  });
});
