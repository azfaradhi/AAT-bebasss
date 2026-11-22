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
  cursor?: string;
}

export interface AggregatorClient {
  getHazards(filter?: HazardsFilter): Promise<HazardEventResponse>;
}

export interface AggregatorCacheOptions { ttlMs?: number; staleMaxAgeMs?: number; maxEntries?: number; now?: () => number }

export class HttpAggregatorClient implements AggregatorClient {
  // Last successful (raw, unfiltered) response per query: a 1 s micro-cache cuts load under a flood, and an older entry is served
  // with meta.stale_since when the aggregator is slow or down, so the critical audience still gets an answer (P5-K5).
  private readonly cache = new Map<string, { at: number; value: HazardEventResponse }>();
  private readonly ttlMs: number;
  private readonly staleMaxAgeMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    private readonly baseUrl: string,
    private readonly internalServiceKey: string,
    private readonly logger: Logger,
    private readonly timeoutMs = 2000,
    cacheOptions: AggregatorCacheOptions = {},
  ) {
    this.ttlMs = cacheOptions.ttlMs ?? 1000;
    this.staleMaxAgeMs = cacheOptions.staleMaxAgeMs ?? 600_000;
    this.maxEntries = cacheOptions.maxEntries ?? 200;
    this.now = cacheOptions.now ?? Date.now;
  }

  async getHazards(filter: HazardsFilter = {}): Promise<HazardEventResponse> {
    const url = new URL('/internal/hazard-events', this.baseUrl);
    if (filter.hazardType) url.searchParams.set('hazard_type', filter.hazardType);
    if (filter.source) url.searchParams.set('source', filter.source);
    if (filter.since) url.searchParams.set('since', filter.since);
    if (filter.limit !== undefined) url.searchParams.set('limit', String(filter.limit));
    if (filter.cursor) url.searchParams.set('cursor', filter.cursor);
    const cacheKey = JSON.stringify([filter.hazardType, filter.source, filter.since, filter.limit, filter.cursor]);
    const cached = this.cache.get(cacheKey);
    if (cached && this.ttlMs > 0 && this.now() - cached.at < this.ttlMs) return cached.value;
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
      const value = (await response.json()) as HazardEventResponse;
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, { at: this.now(), value });
      while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value as string);
      return value;
    } catch (err) {
      // Answer fast with an explicit status instead of a raw 500 when the aggregator is down/slow (P5-K4 spirit).
      if (err instanceof AppError) throw err;
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'aggregator unavailable');
      if (cached && this.now() - cached.at < this.staleMaxAgeMs) {
        this.logger.warn({ age_ms: this.now() - cached.at }, 'served stale response');
        return { ...cached.value, meta: { ...cached.value.meta, stale_since: cached.value.meta.stale_since ?? new Date(cached.at).toISOString() } };
      }
      throw new AppError(503, 'UPSTREAM_UNAVAILABLE', 'Hazard data is temporarily unavailable');
    } finally {
      this.logger.info({ url: url.toString(), latency_ms: Date.now() - started }, 'aggregator request completed');
    }
  }
}
