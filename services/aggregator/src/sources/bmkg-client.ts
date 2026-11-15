import type { SeismicEvent, TsunamiWarning } from '../../../../shared-types/src/seismic';
import type { HazardEvent } from '../../../../shared-types/src/hazard-event';
import { mapSeismicEventToHazardEvent } from '../mapping/seismic-mapper';
import type { Logger } from '../logger';
import { fetchData } from './http';
import { fetchGuarded, mapIsolated, type IngestContext } from '../ingest';
import type { HazardSourceClient } from './source-client';

export interface BmkgClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  logger: Logger;
  ingest?: IngestContext;
}

export class BmkgClient implements HazardSourceClient {
  readonly sourceName = 'BMKG' as const;

  constructor(private readonly opts: BmkgClientOptions) {}

  async poll(since?: string): Promise<HazardEvent[]> {
    const seismicUrl = this.endpoint('/seismic-events', since);
    const warningUrl = this.endpoint('/tsunami-warnings', since);
    const headers = { 'x-bmkg-key': this.opts.apiKey };
    const { ingest, logger, timeoutMs } = this.opts;
    const [events, warnings] = await Promise.all(ingest
      ? [fetchGuarded(ingest, 'BMKG', seismicUrl, headers, timeoutMs, logger), fetchGuarded(ingest, 'BMKG', warningUrl, headers, timeoutMs, logger)]
      : [fetchData<SeismicEvent>('BMKG', seismicUrl, headers, timeoutMs, logger), fetchData<TsunamiWarning>('BMKG', warningUrl, headers, timeoutMs, logger)]);
    const warningByEventId = new Map((warnings as TsunamiWarning[]).filter((w) => typeof w?.related_event_id === 'string').map((w) => [w.related_event_id, w]));
    const map = (event: SeismicEvent) => mapSeismicEventToHazardEvent(event, warningByEventId.get(event.event_id));
    return ingest ? mapIsolated(ingest, 'BMKG', events as SeismicEvent[], map, (e) => e.event_id, logger) : (events as SeismicEvent[]).map(map);
  }

  private endpoint(path: string, since?: string): URL {
    const url = new URL(path, this.opts.baseUrl);
    if (since) url.searchParams.set('since', since);
    return url;
  }
}
