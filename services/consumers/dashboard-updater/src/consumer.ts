import amqp from 'amqplib';
import { processMessage, type HandlerDeps } from './handler';
import type { Logger } from './logger';
import { assertTopology, QUEUE_NAME } from './topology';

type Connection = Awaited<ReturnType<typeof amqp.connect>>;

export interface ConsumerOptions {
  url: string;
  logger: Logger;
  handler: HandlerDeps;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

export class HazardEventConsumer {
  private connection: Connection | null = null;
  private connected = false;
  private closing = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelayMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;

  constructor(private readonly opts: ConsumerOptions) {
    this.reconnectMinMs = opts.reconnectMinMs ?? 1000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 30000;
    this.retryDelayMs = this.reconnectMinMs;
  }

  async start(): Promise<void> {
    await this.tryConnect();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.connected = false;
    const connection = this.connection;
    this.connection = null;
    await connection?.close().catch(() => undefined);
  }

  private async tryConnect(): Promise<void> {
    if (this.closing) return;
    const { logger } = this.opts;
    try {
      const connection = await amqp.connect(this.opts.url);
      connection.on('error', (err: Error) => logger.error({ err: err.message }, 'broker connection error'));
      connection.on('close', () => this.onDisconnected('broker connection closed'));

      const channel = await connection.createChannel();
      await assertTopology(channel);
      await channel.prefetch(1);
      await channel.consume(
        QUEUE_NAME,
        async (msg) => {
          if (msg === null) {
            this.onDisconnected('consumer cancelled by broker');
            return;
          }
          const outcome = await processMessage(msg.content, this.opts.handler);
          try {
            if (outcome === 'ack') channel.ack(msg);
            else channel.nack(msg, false, outcome === 'requeue');
          } catch (err) {
            logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not settle delivery');
          }
        },
        { noAck: false },
      );

      this.connection = connection;
      this.connected = true;
      this.retryDelayMs = this.reconnectMinMs;
      logger.info({ queue: QUEUE_NAME }, 'consuming');
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'broker connect failed');
      this.scheduleReconnect();
    }
  }

  private onDisconnected(reason: string): void {
    this.connected = false;
    this.connection = null;
    if (!this.closing) {
      this.opts.logger.warn({}, `${reason}, reconnecting`);
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
