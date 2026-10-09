import type { Logger } from '../logger';
import { contextStorage } from '../context';
import type { CanonicalStore } from '../storage/canonical-store';
import type { EventPublisher } from './event-publisher';

const DISPATCH_INTERVAL_MS = 1000;
const PUBLICATION_LEASE_MS = 30000;
const MAX_PUBLICATIONS_PER_TICK = 100;

export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;

  constructor(
    private readonly store: CanonicalStore,
    private readonly publisher: EventPublisher,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.flush();
    this.timer = setInterval(() => void this.flush(), DISPATCH_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
  }

  // A failed confirmation leaves the durable row pending. A second process can reclaim
  // a lease after a crash; this is at-least-once delivery, not exactly-once delivery.
  async flush(): Promise<void> {
    if (this.active) return this.active;
    const work = this.drain().catch((err: unknown) => {
      this.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'outbox dispatch failed');
    });
    this.active = work;
    try {
      await work;
    } finally {
      if (this.active === work) this.active = null;
    }
  }

  private async drain(): Promise<void> {
    for (let processed = 0; processed < MAX_PUBLICATIONS_PER_TICK; processed++) {
      const pending = await this.store.claimPendingPublication(PUBLICATION_LEASE_MS);
      if (!pending) return;
      const delivered = await contextStorage.run({ correlationId: pending.correlationId }, async () => {
        try {
          await this.publisher.publish(pending.event, pending.correlationId, pending.messageId);
          await this.store.markPublicationSent(pending.messageId);
          return true;
        } catch (err) {
          await this.store.releasePublication(pending.messageId);
          this.logger.error(
            { hazard_id: pending.event.hazard_id, message_id: pending.messageId, err: err instanceof Error ? err.message : String(err) },
            'hazard event publication deferred for retry',
          );
          return false;
        }
      });
      if (!delivered) return;
    }
  }
}
