import type { HazardEventResponse, HazardType } from '../../../../shared-types/src/hazard-event';
import type { Logger } from '../logger';

export interface AggregatorClient {
  getHazards(hazardType?: HazardType): Promise<HazardEventResponse>;
}

export class HttpAggregatorClient implements AggregatorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalServiceKey: string,
    private readonly logger: Logger,
  ) {}

  async getHazards(hazardType?: HazardType): Promise<HazardEventResponse> {
    const url = new URL('/internal/hazard-events', this.baseUrl);
    if (hazardType) url.searchParams.set('hazard_type', hazardType);
    const started = Date.now();
    this.logger.info({ url: url.toString() }, 'aggregator request started');
    try {
      const response = await fetch(url, { headers: { 'x-internal-service-key': this.internalServiceKey } });
      if (!response.ok) throw new Error(`Aggregator returned HTTP ${response.status}`);
      return await response.json() as HazardEventResponse;
    } finally {
      this.logger.info({ url: url.toString(), latency_ms: Date.now() - started }, 'aggregator request completed');
    }
  }
}
