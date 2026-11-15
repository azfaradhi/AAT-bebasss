import type { VolcanicReport } from '../../../../shared-types/src/volcanic';
import type { HazardEvent } from '../../../../shared-types/src/hazard-event';
import { mapVolcanicReportToHazardEvent } from '../mapping/volcanic-mapper';
import { SchemaIncompatibleError } from '../mapping/volcanic-schema';
import type { Logger } from '../logger';
import { CircuitBreaker } from '../resilience/circuit-breaker';
import { ConcurrencyLimiter } from '../resilience/concurrency-limiter';
import { fetchData } from './http';
import type { HazardSourceClient } from './source-client';

export interface PvmbgClientOptions {
  baseUrl: string;
  accessToken: string;
  timeoutMs: number;
  logger: Logger;
  circuitBreaker: CircuitBreaker;
  limiter: ConcurrencyLimiter;
}

export class PvmbgClient implements HazardSourceClient {
  readonly sourceName = 'PVMBG' as const;

  constructor(private readonly opts: PvmbgClientOptions) {}

  async poll(since?: string): Promise<HazardEvent[]> {
    return this.opts.limiter.run(() => this.opts.circuitBreaker.execute(async () => {
      const url = new URL('/volcanic-reports', this.opts.baseUrl);
      if (since) url.searchParams.set('since', since);
      const reports = await fetchData<VolcanicReport>(
        'PVMBG',
        url,
        { authorization: `Bearer ${this.opts.accessToken}` },
        this.opts.timeoutMs,
        this.opts.logger,
      );
      const events: HazardEvent[] = [];
      for (const report of reports) {
        try {
          events.push(mapVolcanicReportToHazardEvent(report));
        } catch (err) {
          if (!(err instanceof SchemaIncompatibleError)) throw err;
          this.opts.logger.warn({ reason_code: err.reason_code, detail: err.detail }, 'pvmbg record skipped');
        }
      }
      return events;
    }));
  }
}
