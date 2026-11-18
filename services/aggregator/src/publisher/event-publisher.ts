import amqp from 'amqplib';
import { randomUUID } from 'node:crypto';
import type { HazardEvent } from '../../../../shared-types/src/hazard-event';
import type { HazardEventMessage } from '../../../../shared-types/src/envelopes';
import type { CriticalAlertMessage } from '../../../../shared-types/src/m2/types';
import { assertTopology, CRITICAL_ALERTS_QUEUE, EXCHANGE_NAME } from './topology';
import { METRICS, amqpInject, incCounter } from '../resilience/obs';

export interface EventPublisher {
  publish(event: HazardEvent, correlationId: string, messageId?: string): Promise<void>;
  publishCriticalAlert?(alert: CriticalAlertMessage): Promise<void>;
}

export interface PublisherLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export class BrokerUnavailableError extends Error {
  readonly code = 'BROKER_UNAVAILABLE';
  constructor(message = 'Message broker is not connected') {
    super(message);
    this.name = 'BrokerUnavailableError';
  }
}

export interface RabbitMqPublisherOptions {
  url: string;
  logger: PublisherLogger;
  publishTimeoutMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type ConfirmChannel = Awaited<ReturnType<Connection['createConfirmChannel']>>;

export class RabbitMqEventPublisher implements EventPublisher {
  private connection: Connection | null = null;
  private channel: ConfirmChannel | null = null;
  private closing = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelayMs: number;

  private readonly publishTimeoutMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;

  constructor(private readonly opts: RabbitMqPublisherOptions) {
    this.publishTimeoutMs = opts.publishTimeoutMs ?? 5000;
    this.reconnectMinMs = opts.reconnectMinMs ?? 1000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 30000;
    this.retryDelayMs = this.reconnectMinMs;
  }

  async start(): Promise<void> {
    await this.tryConnect();
  }

  isConnected(): boolean {
    return this.channel !== null;
  }

  async publish(event: HazardEvent, correlationId: string, messageId = randomUUID()): Promise<void> {
    const channel = this.channel;
    if (!channel) throw new BrokerUnavailableError();

    const message: HazardEventMessage = {
      message_id: messageId,
      event_type: 'HazardEventCreated',
      version: 1,
      published_at: new Date().toISOString(),
      correlation_id: correlationId,
      payload: event,
    };
    const started = Date.now();
    this.opts.logger.info({ message_id: message.message_id, hazard_id: event.hazard_id }, 'publishing hazard event');

    await this.publishAndConfirm(channel, EXCHANGE_NAME, '', message, {
      messageId: message.message_id,
      correlationId: message.correlation_id,
      type: message.event_type,
      headers: amqpInject({
        message_id: message.message_id,
        'x-correlation-id': correlationId,
      }),
    });

    this.opts.logger.info(
      { message_id: message.message_id, hazard_id: event.hazard_id, latency_ms: Date.now() - started },
      'hazard event published',
    );
  }

  async publishCriticalAlert(alert: CriticalAlertMessage): Promise<void> {
    const channel = this.channel;
    if (!channel) throw new BrokerUnavailableError();

    const started = Date.now();
    await this.publishAndConfirm(channel, '', CRITICAL_ALERTS_QUEUE, alert, {
      messageId: alert.message_id,
      correlationId: alert.correlation_id,
      type: 'CriticalAlertCreated',
      priority: 10,
      headers: amqpInject({
        message_id: alert.message_id,
        'x-correlation-id': alert.correlation_id,
      }),
    });

    incCounter(METRICS.criticalTotal, { outcome: 'published' });
    this.opts.logger.info(
      { message_id: alert.message_id, hazard_id: alert.hazard_id, latency_ms: Date.now() - started },
      'critical alert published to fast path',
    );
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const connection = this.connection;
    this.channel = null;
    this.connection = null;
    await connection?.close().catch(() => undefined);
  }

  private publishAndConfirm(
    channel: ConfirmChannel,
    exchange: string,
    routingKey: string,
    payload: unknown,
    options: amqp.Options.Publish,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new BrokerUnavailableError(`Publish not confirmed within ${this.publishTimeoutMs}ms`)),
        this.publishTimeoutMs,
      );
      try {
        channel.publish(
          exchange,
          routingKey,
          Buffer.from(JSON.stringify(payload)),
          {
            persistent: true,
            contentType: 'application/json',
            ...options,
          },
          (err) => {
            clearTimeout(timer);
            if (err) reject(err instanceof Error ? err : new Error(String(err)));
            else resolve();
          },
        );
      } catch (err) {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async tryConnect(): Promise<void> {
    if (this.closing) return;
    try {
      const connection = await amqp.connect(this.opts.url);
      connection.on('error', (err: Error) => this.opts.logger.error({ err: err.message }, 'broker connection error'));
      connection.on('close', () => {
        this.channel = null;
        this.connection = null;
        if (!this.closing) {
          this.opts.logger.warn({}, 'broker connection closed, reconnecting');
          this.scheduleReconnect();
        }
      });
      const channel = await connection.createConfirmChannel();
      await assertTopology(channel);
      this.connection = connection;
      this.channel = channel;
      this.retryDelayMs = this.reconnectMinMs;
      this.opts.logger.info({}, 'broker connected, topology asserted');
    } catch (err) {
      this.opts.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'broker connect failed');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closing || this.retryTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.reconnectMaxMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.tryConnect();
    }, delay);
    this.retryTimer.unref();
  }
}
