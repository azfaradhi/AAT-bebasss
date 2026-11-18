import type { VolcanicReport } from '../../../../shared-types/src/volcanic';
import type { HazardEvent } from '../../../../shared-types/src/hazard-event';
import { mapVolcanicReportToHazardEvent } from '../mapping/volcanic-mapper';
import { SchemaIncompatibleError, type MapperVersion } from '../mapping/volcanic-schema';
import type { Logger } from '../logger';
import { CircuitBreaker } from '../resilience/circuit-breaker';
import { ConcurrencyLimiter } from '../resilience/concurrency-limiter';
import { fetchData } from './http';
import { fetchGuarded, mapIsolated, type IngestContext } from '../ingest';
import type { HazardSourceClient } from './source-client';

export interface PvmbgClientOptions {
  baseUrl: string;
  accessToken: string;
  timeoutMs: number;
  logger: Logger;
  circuitBreaker: CircuitBreaker;
  limiter: ConcurrencyLimiter;
  ingest?: IngestContext;
  mapperVersion?: MapperVersion;
}

export class PvmbgClient implements HazardSourceClient {
  readonly sourceName = 'PVMBG' as const;

  constructor(private readonly opts: PvmbgClientOptions) {}

  async poll(since?: string): Promise<HazardEvent[]> {
    return this.opts.limiter.run(() => this.opts.circuitBreaker.execute(async () => {
      const url = new URL('/volcanic-reports', this.opts.baseUrl);
      if (since) url.searchParams.set('since', since);
      const headers = { authorization: `Bearer ${this.opts.accessToken}` };
      const { ingest, logger } = this.opts;
      const version = this.opts.mapperVersion ?? (process.env.VOLCANIC_MAPPER_VERSION === 'v2' ? 'v2' : 'v1');
      const map = (report: VolcanicReport) => mapVolcanicReportToHazardEvent(report, version);
      if (ingest) {
        const items = (await fetchGuarded(ingest, 'PVMBG', url, headers, this.opts.timeoutMs, logger)) as VolcanicReport[];
        return mapIsolated(ingest, 'PVMBG', items, map, (r) => r.report_id, logger);
      }
      const reports = await fetchData<VolcanicReport>('PVMBG', url, headers, this.opts.timeoutMs, logger);
      const events: HazardEvent[] = [];
      for (const report of reports) {
        try {
          events.push(map(report));
        } catch (err) {
          if (!(err instanceof SchemaIncompatibleError)) throw err;
          this.opts.logger.warn({ reason_code: err.reason_code, detail: err.detail }, 'pvmbg record skipped');
        }
      }
      return events;
    }));
  }
}
