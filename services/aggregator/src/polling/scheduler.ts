import { randomUUID } from 'node:crypto';
import type { EventPublisher } from '../publisher/eventPublisher';
import { contextStorage } from '../context';
import type { Logger } from '../logger';
import type { HazardSourceClient } from '../sources/source-client';
import type { CanonicalStore } from '../storage/canonical-store';

export interface PollingSchedulerOptions {
  bmkg: HazardSourceClient;
  pvmbg: HazardSourceClient;
  store: CanonicalStore;
  publisher: EventPublisher;
  intervalMs: number;
  lookbackMs: number;
  logger: Logger;
}

export class PollingScheduler {
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight = false;

  constructor(private readonly opts: PollingSchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    void this.runTick();
    this.timer = setInterval(() => void this.runTick(), this.opts.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runTick(): Promise<void> {
    if (this.tickInFlight) {
      this.opts.logger.warn({}, 'polling tick skipped because the previous tick is still running');
      return;
    }
    this.tickInFlight = true;

    try {
      await contextStorage.run({ correlationId: randomUUID() }, async () => {
        const started = Date.now();
        const results = await Promise.allSettled([this.pollSource(this.opts.bmkg), this.pollSource(this.opts.pvmbg)]);
        const failedSources = results.filter((result) => result.status === 'rejected').length;
        this.opts.logger.info(
          { source_count: 2, failed_sources: failedSources, latency_ms: Date.now() - started },
          'polling tick completed',
        );
      });
    } finally {
      this.tickInFlight = false;
    }
  }

  private async pollSource(source: HazardSourceClient): Promise<void> {
    const started = Date.now();
    this.opts.logger.info({ source: source.sourceName }, 'source poll started');
    try {
      const lastSuccessAt = await this.opts.store.getLastSuccessAt(source.sourceName);
      const since = lastSuccessAt
        ? new Date(lastSuccessAt.getTime() - this.opts.lookbackMs).toISOString()
        : undefined;
      const events = await source.poll(since);
      for (const event of events) {
        const stored = await this.opts.store.upsert(event);
        if (stored.created) {
          try {
            await this.opts.publisher.publish(stored.event, contextStorage.getStore()?.correlationId ?? randomUUID());
          } catch (err) {
            this.opts.logger.error(
              { source: source.sourceName, hazard_id: stored.event.hazard_id, err: err instanceof Error ? err.message : String(err) },
              'hazard event could not be published',
            );
          }
        }
      }
      await this.opts.store.markSourceFresh(source.sourceName);
      this.opts.logger.info({ source: source.sourceName, latency_ms: Date.now() - started }, 'source poll completed');
    } catch (err) {
      await this.opts.store.markSourceStale(source.sourceName);
      this.opts.logger.error(
        { source: source.sourceName, latency_ms: Date.now() - started, err: err instanceof Error ? err.message : String(err) },
        'source poll failed',
      );
      throw err;
    }
  }
}
