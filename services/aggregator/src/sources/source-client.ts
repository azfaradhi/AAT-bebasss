import type { HazardEvent } from '../../../../shared-types/src/hazard-event';

export interface HazardSourceClient {
  readonly sourceName: 'BMKG' | 'PVMBG';
  poll(since?: string): Promise<HazardEvent[]>;
}

export class UpstreamRequestError extends Error {
  constructor(
    public readonly source: string,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'UpstreamRequestError';
  }
}
