import type { HazardEventResponse, HazardSource, HazardType } from '../../../../shared-types/src/hazard-event';
import type { Logger } from '../logger';
import { currentCorrelationId } from '../context';
import { instrumentOutbound } from '../obs/index';
import { AppError } from '../errors';

export interface HazardsFilter {
  hazardType?: HazardType;
  source?: HazardSource;
  since?: string;
  limit?: number;
}

export interface AggregatorClient {
  getHazards(filter?: HazardsFilter): Promise<HazardEventResponse>;
}

export class HttpAggregatorClient implements AggregatorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalServiceKey: string,
    private readonly logger: Logger,
    private readonly timeoutMs = 2000,
  ) {}

  async getHazards(filter: HazardsFilter = {}): Promise<HazardEventResponse> {
    const url = new URL('/internal/hazard-events', this.baseUrl);
    if (filter.hazardType) url.searchParams.set('hazard_type', filter.hazardType);
    if (filter.source) url.searchParams.set('source', filter.source);
    if (filter.since) url.searchParams.set('since', filter.since);
    if (filter.limit !== undefined) url.searchParams.set('limit', String(filter.limit));
    const started = Date.now();
    this.logger.info({ url: url.toString() }, 'aggregator request started');
    try {
      const correlationId = currentCorrelationId();
      const response = await instrumentOutbound('aggregator', (traceHeaders) =>
        fetch(url, {
          headers: {
            ...traceHeaders,
            'x-internal-key': this.internalServiceKey,
            ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        }),
      );
      if (!response.ok) throw new Error(`Aggregator returned HTTP ${response.status}`);
      return (await response.json()) as HazardEventResponse;
    } catch (err) {
      // Answer fast with an explicit status instead of a raw 500 when the aggregator is down/slow (P5-K4 spirit).
      if (err instanceof AppError) throw err;
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'aggregator unavailable');
      throw new AppError(503, 'UPSTREAM_UNAVAILABLE', 'Hazard data is temporarily unavailable');
    } finally {
      this.logger.info({ url: url.toString(), latency_ms: Date.now() - started }, 'aggregator request completed');
    }
  }
}
