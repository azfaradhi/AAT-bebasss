import amqp from 'amqplib';
import { randomUUID } from 'node:crypto';
import type { HazardEvent } from '../../../../shared-types/src/hazard-event';
import type { HazardEventMessage } from '../../../../shared-types/src/envelopes';
import { assertTopology, EXCHANGE_NAME } from './topology';

// The scheduler depends only on this interface.
export interface EventPublisher {
  publish(event: HazardEvent, correlationId: string, messageId?: string): Promise<void>;
}

// Structurally compatible with a pino logger, so we don't need to import one here.
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

// Publishes to the fanout exchange without ever addressing a consumer directly.
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

  // Never throws; retries in the background. publish() rejects fast until a channel exists.
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

    await this.publishAndConfirm(channel, message);

    this.opts.logger.info(
      { message_id: message.message_id, hazard_id: event.hazard_id, latency_ms: Date.now() - started },
      'hazard event published',
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

  // Resolves only after the broker confirms the message was persisted.
  private publishAndConfirm(channel: ConfirmChannel, message: HazardEventMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new BrokerUnavailableError(`Publish not confirmed within ${this.publishTimeoutMs}ms`)),
        this.publishTimeoutMs,
      );
      try {
        channel.publish(
          EXCHANGE_NAME,
          '', // fanout ignores the routing key
          Buffer.from(JSON.stringify(message)),
          {
            persistent: true,
            contentType: 'application/json',
            messageId: message.message_id,
            correlationId: message.correlation_id,
            type: message.event_type,
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
