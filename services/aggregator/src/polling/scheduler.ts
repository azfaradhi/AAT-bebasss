// Drafted with LLM assistance; the committing team member must review and understand this code.
import { randomUUID } from 'node:crypto';
import { contextStorage } from '../context';
import type { Logger } from '../logger';
import type { PollingSource } from '../sources/stub-source-client';

export interface PollingSchedulerOptions {
  sources: readonly PollingSource[];
  intervalMs: number;
  logger: Logger;
}

// Phase 1 scheduler: it proves the non-blocking polling shape before real source clients and storage are added.
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
        const results = await Promise.allSettled(this.opts.sources.map((source) => this.pollSource(source)));
        const failedSources = results.filter((result) => result.status === 'rejected').length;
        this.opts.logger.info(
          { source_count: this.opts.sources.length, failed_sources: failedSources, latency_ms: Date.now() - started },
          'polling tick completed',
        );
      });
    } finally {
      this.tickInFlight = false;
    }
  }

  private async pollSource(source: PollingSource): Promise<void> {
    const started = Date.now();
    this.opts.logger.info({ source: source.name }, 'source poll started');
    try {
      await source.poll();
      this.opts.logger.info({ source: source.name, latency_ms: Date.now() - started }, 'source poll completed');
    } catch (err) {
      this.opts.logger.error(
        { source: source.name, latency_ms: Date.now() - started, err: err instanceof Error ? err.message : String(err) },
        'source poll failed',
      );
      throw err;
    }
  }
}
