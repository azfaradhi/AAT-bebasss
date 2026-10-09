import { randomUUID } from 'node:crypto';
import { contextStorage } from '../context';
import type { Logger } from '../logger';
import type { HazardSourceClient } from '../sources/source-client';
import type { CanonicalStore } from '../storage/canonical-store';

export interface PollingSchedulerOptions {
  bmkg: HazardSourceClient;
  pvmbg: HazardSourceClient;
  store: CanonicalStore;
  intervalMs: number;
  lookbackMs: number;
  logger: Logger;
}

// Each source has its own loop and its own in-flight guard, so a slow source never delays another one.
export class PollingScheduler {
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly inFlight = new Set<HazardSourceClient['sourceName']>();

  constructor(private readonly opts: PollingSchedulerOptions) {}

  start(): void {
    if (this.timers.length > 0) return;
    for (const source of [this.opts.bmkg, this.opts.pvmbg]) {
      void this.runSourceTick(source);
      const timer = setInterval(() => void this.runSourceTick(source), this.opts.intervalMs);
      timer.unref();
      this.timers.push(timer);
    }
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }

  // One poll for every source. The sources run independently and do not wait for each other.
  async runTick(): Promise<void> {
    await Promise.all([this.runSourceTick(this.opts.bmkg), this.runSourceTick(this.opts.pvmbg)]);
  }

  async runSourceTick(source: HazardSourceClient): Promise<void> {
    if (this.inFlight.has(source.sourceName)) {
      this.opts.logger.warn(
        { source: source.sourceName },
        'polling tick skipped because the previous tick for this source is still running',
      );
      return;
    }
    this.inFlight.add(source.sourceName);

    try {
      await contextStorage.run({ correlationId: randomUUID() }, async () => {
        const started = Date.now();
        try {
          await this.pollSource(source);
        } catch {
          // pollSource already logged the failure and marked the source stale.
        }
        this.opts.logger.info(
          { source: source.sourceName, latency_ms: Date.now() - started },
          'polling tick completed',
        );
      });
    } finally {
      this.inFlight.delete(source.sourceName);
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
        await this.opts.store.upsert(event, contextStorage.getStore()?.correlationId ?? randomUUID());
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
