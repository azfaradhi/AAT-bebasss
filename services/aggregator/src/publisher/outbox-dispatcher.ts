import type { Logger } from '../logger';
import { contextStorage } from '../context';
import type { CanonicalStore } from '../storage/canonical-store';
import type { CriticalAlertMessage, OutboxItem, StorageClient } from '../../../../shared-types/src/m2/types';
import type { EventPublisher } from './event-publisher';
import { METRICS, setGauge } from '../resilience/obs';

const DISPATCH_INTERVAL_MS = 500;
const PUBLICATION_LEASE_MS = 10000;
const MAX_PUBLICATIONS_PER_TICK = 100;

type OutboxBackingStore = CanonicalStore | StorageClient;

function isM2StorageClient(store: OutboxBackingStore): store is StorageClient {
  return typeof (store as StorageClient).claimOutbox === 'function';
}

export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;

  constructor(
    private readonly store: OutboxBackingStore,
    private readonly publisher: EventPublisher,
    private readonly logger: Logger,
    private readonly intervalMs = DISPATCH_INTERVAL_MS,
    private readonly leaseMs = PUBLICATION_LEASE_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.flush();
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
  }

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
    if (isM2StorageClient(this.store)) {
      await this.drainM2Storage(this.store);
      return;
    }

    const m1Store = this.store;
    for (let processed = 0; processed < MAX_PUBLICATIONS_PER_TICK; processed++) {
      const pending = await m1Store.claimPendingPublication(this.leaseMs);
      if (!pending) return;
      const delivered = await contextStorage.run({ correlationId: pending.correlationId }, async () => {
        try {
          await this.publisher.publish(pending.event, pending.correlationId, pending.messageId);
          await m1Store.markPublicationSent(pending.messageId);
          return true;
        } catch (err) {
          await m1Store.releasePublication(pending.messageId);
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

  private async drainM2Storage(storage: StorageClient): Promise<void> {
    const claimed = await storage.claimOutbox(MAX_PUBLICATIONS_PER_TICK, this.leaseMs);
    if (claimed.length === 0) {
      const pendingCount = await storage.outboxPending().catch(() => 0);
      setGauge(METRICS.outboxPending, {}, pendingCount);
      return;
    }

    // Prioritize critical alerts ahead of normal hazard events (P5-K1)
    const sorted: OutboxItem[] = [...claimed].sort((a, b) => {
      if (a.priority === b.priority) return 0;
      return a.priority === 'critical' ? -1 : 1;
    });

    const publishedIds: string[] = [];
    for (const item of sorted) {
      const ok = await contextStorage.run({ correlationId: item.correlation_id }, async () => {
        try {
          const { version: _v, ...publicEvent } = item.event;
          await this.publisher.publish(publicEvent, item.correlation_id, item.message_id);

          if (item.priority === 'critical' && this.publisher.publishCriticalAlert) {
            const alertMsg: CriticalAlertMessage = {
              message_id: item.message_id,
              hazard_id: item.hazard_id,
              source: item.event.source,
              severity: item.event.severity,
              area_name: item.event.area_name,
              occurred_at: item.event.occurred_at,
              detected_at: item.event.ingested_at,
              correlation_id: item.correlation_id,
            };
            await this.publisher.publishCriticalAlert(alertMsg);
          }
          return true;
        } catch (err) {
          this.logger.error(
            { hazard_id: item.hazard_id, message_id: item.message_id, err: err instanceof Error ? err.message : String(err) },
            'm2 outbox publication deferred for retry after lease expiry',
          );
          return false;
        }
      });

      if (ok) {
        publishedIds.push(item.message_id);
      } else {
        break;
      }
    }

    if (publishedIds.length > 0) {
      await storage.markOutboxPublished(publishedIds);
    }

    const remaining = await storage.outboxPending().catch(() => 0);
    setGauge(METRICS.outboxPending, {}, remaining);
  }
}
