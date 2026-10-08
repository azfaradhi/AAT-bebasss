import amqp from 'amqplib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HazardEvent } from '../../../../shared-types/src/hazard-event';
import { BrokerUnavailableError, RabbitMqEventPublisher } from './event-publisher';

vi.mock('amqplib', () => ({ default: { connect: vi.fn() } }));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const event: HazardEvent = {
  hazard_id: 'h-1',
  source: 'BMKG',
  source_ref_id: 'e-1',
  hazard_type: 'SEISMIC',
  severity: 'SIAGA',
  area_name: 'Test Region',
  latitude: -6.2,
  longitude: 106.8,
  occurred_at: '2026-09-26T10:00:00.000Z',
  ingested_at: '2026-09-26T10:00:01.000Z',
  attributes: { magnitude: 6.6 },
};

function fakeBroker(confirm: (cb: (err: unknown) => void) => void = (cb) => cb(null)) {
  const channel = {
    assertExchange: vi.fn().mockResolvedValue(undefined),
    assertQueue: vi.fn().mockResolvedValue(undefined),
    bindQueue: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn((_e: string, _k: string, _c: Buffer, _o: object, cb: (err: unknown) => void) => {
      confirm(cb);
      return true;
    }),
  };
  const connection = { on: vi.fn(), createConfirmChannel: vi.fn().mockResolvedValue(channel), close: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(amqp.connect).mockResolvedValue(connection as never);
  return { channel, connection };
}

function makePublisher(overrides = {}) {
  return new RabbitMqEventPublisher({ url: 'amqp://x', logger, publishTimeoutMs: 50, reconnectMinMs: 10, reconnectMaxMs: 20, ...overrides });
}

beforeEach(() => vi.clearAllMocks());

describe('RabbitMqEventPublisher', () => {
  it('asserts a durable fanout exchange and both durable queues bound to it', async () => {
    const { channel } = fakeBroker();
    const publisher = makePublisher();
    await publisher.start();
    expect(channel.assertExchange).toHaveBeenCalledWith('hazard_events_exchange', 'fanout', { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith('dashboard_updater_queue', { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith('notifier_queue', { durable: true });
    expect(channel.bindQueue).toHaveBeenCalledWith('dashboard_updater_queue', 'hazard_events_exchange', '');
    expect(channel.bindQueue).toHaveBeenCalledWith('notifier_queue', 'hazard_events_exchange', '');
    await publisher.close();
  });

  it('publishes a persistent HazardEventMessage envelope to the exchange', async () => {
    const { channel } = fakeBroker();
    const publisher = makePublisher();
    await publisher.start();
    await publisher.publish(event, 'corr-42');

    const [exchange, key, content, options] = channel.publish.mock.calls[0];
    expect(exchange).toBe('hazard_events_exchange');
    expect(key).toBe('');
    expect(options).toMatchObject({ persistent: true, contentType: 'application/json' });
    const message = JSON.parse((content as Buffer).toString());
    expect(message).toMatchObject({
      event_type: 'HazardEventCreated',
      version: 1,
      correlation_id: 'corr-42',
      payload: event,
    });
    expect(message.message_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(message.published_at).toString()).not.toBe('Invalid Date');
    await publisher.close();
  });

  it('logs latency_ms on completion', async () => {
    fakeBroker();
    const publisher = makePublisher();
    await publisher.start();
    await publisher.publish(event, 'c');
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ latency_ms: expect.any(Number) }), 'hazard event published');
    await publisher.close();
  });

  it('rejects fast with BrokerUnavailableError when not connected', async () => {
    vi.mocked(amqp.connect).mockRejectedValue(new Error('ECONNREFUSED'));
    const publisher = makePublisher();
    await publisher.start(); // does not throw
    expect(publisher.isConnected()).toBe(false);
    await expect(publisher.publish(event, 'c')).rejects.toBeInstanceOf(BrokerUnavailableError);
    await publisher.close();
  });

  it('connects in the background once the broker comes up', async () => {
    vi.mocked(amqp.connect).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    fakeBroker();
    vi.mocked(amqp.connect).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const publisher = makePublisher();
    await publisher.start();
    expect(publisher.isConnected()).toBe(false);
    fakeBroker();
    await vi.waitFor(() => expect(publisher.isConnected()).toBe(true), { timeout: 1000 });
    await publisher.close();
  });

  it('rejects when the broker nacks the message', async () => {
    fakeBroker((cb) => cb(new Error('nacked')));
    const publisher = makePublisher();
    await publisher.start();
    await expect(publisher.publish(event, 'c')).rejects.toThrow('nacked');
    await publisher.close();
  });

  it('rejects instead of hanging when the confirm never arrives', async () => {
    fakeBroker(() => undefined);
    const publisher = makePublisher({ publishTimeoutMs: 20 });
    await publisher.start();
    await expect(publisher.publish(event, 'c')).rejects.toBeInstanceOf(BrokerUnavailableError);
    await publisher.close();
  });
});
