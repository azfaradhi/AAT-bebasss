import type { SeismicEvent, TsunamiWarning } from '../../../../shared-types/src/seismic';
import type { HazardEvent } from '../../../../shared-types/src/hazard-event';
import { mapSeismicEventToHazardEvent } from '../mapping/seismic-mapper';
import type { Logger } from '../logger';
import { fetchData } from './http';
import type { HazardSourceClient } from './source-client';

export interface BmkgClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  logger: Logger;
}

export class BmkgClient implements HazardSourceClient {
  readonly sourceName = 'BMKG' as const;

  constructor(private readonly opts: BmkgClientOptions) {}

  async poll(since?: string): Promise<HazardEvent[]> {
    const seismicUrl = this.endpoint('/seismic-events', since);
    const warningUrl = this.endpoint('/tsunami-warnings', since);
    const headers = { 'x-bmkg-key': this.opts.apiKey };
    const [events, warnings] = await Promise.all([
      fetchData<SeismicEvent>('BMKG', seismicUrl, headers, this.opts.timeoutMs, this.opts.logger),
      fetchData<TsunamiWarning>('BMKG', warningUrl, headers, this.opts.timeoutMs, this.opts.logger),
    ]);
    const warningByEventId = new Map(warnings.map((warning) => [warning.related_event_id, warning]));
    return events.map((event) => mapSeismicEventToHazardEvent(event, warningByEventId.get(event.event_id)));
  }

  private endpoint(path: string, since?: string): URL {
    const url = new URL(path, this.opts.baseUrl);
    if (since) url.searchParams.set('since', since);
    return url;
  }
}
