import type { Logger } from '../logger';
import type { IngestContext } from './context';

export interface RetrySweeperOptions {
  ingest: IngestContext;
  handler: (raw: Uint8Array) => Promise<void>;
  intervalMs: number;
  logger: Logger;
  now?: () => number;
  // Runs `tick` only while this instance is leader (Coordinator.runAsLeader('ingest-retry')); runs it directly when omitted.
  gate?: (tick: () => Promise<void>) => Promise<void>;
}

// Re-attempts `retrying` parked messages whose next_attempt_at has passed.
export class IngestRetrySweeper {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly opts: RetrySweeperOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.run(), this.opts.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await (this.opts.gate ? this.opts.gate(() => this.tick()) : this.tick());
    } catch (err) {
      this.opts.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'ingest retry sweep failed');
    } finally {
      this.running = false;
    }
  }

  async tick(): Promise<void> {
    const { ingest, handler, logger } = this.opts;
    const report = await ingest.parker.replay(
      { includeRetryable: true, statuses: ['retrying'], dueBy: new Date((this.opts.now ?? Date.now)()).toISOString() },
      handler,
      ingest.writeCtx('ingest-retry'),
    );
    await ingest.metrics.refreshParked(ingest.parker);
    if (report.considered > 0) logger.info({ ...report }, 'ingest retry sweep');
  }
}
