import type { HazardEvent } from '../../../../shared-types/src/hazard-event';
import { hazardId, nextIngestedAt } from '../../../../shared-types/src/m2/ids';
import type { ParkedMessage, ParkSource, ReasonCode, ReplayReport } from '../../../../shared-types/src/m2/types';
import { mapSeismicEventToHazardEvent } from '../mapping/seismic-mapper';
import { mapVolcanicReportToHazardEvent } from '../mapping/volcanic-mapper';
import type { MapperVersion } from '../mapping/volcanic-schema';
import type { IngestContext } from './context';
import type { HazardWriter } from './hazard-writer';

export interface ReplayDeps {
  ingest: IngestContext;
  writer: HazardWriter;
  mapperVersion: MapperVersion;
  clock?: () => number;
}

export interface ReplayQuery { reason_code?: ReasonCode; source?: ParkSource; includeRetryable?: boolean }

const isMappedEvent = (v: unknown): v is HazardEvent =>
  typeof v === 'object' && v !== null && 'source_ref_id' in v && 'hazard_type' in v && 'attributes' in v;

// Re-runs one parked message. Ids are deterministic (hazardId(source, source_ref_id)) and the writer is idempotent,
// so a replayed or repeated message can never create a second event.
export function replayHandler(deps: ReplayDeps): (raw: Uint8Array, meta: ParkedMessage) => Promise<void> {
  let floor: string | null = null;
  return async (raw, meta) => {
    if (meta.raw_truncated) throw new Error('raw payload was truncated when parked; cannot replay');
    const parsed: unknown = JSON.parse(Buffer.from(raw).toString('utf8'));
    let event: HazardEvent;
    if (isMappedEvent(parsed)) {
      event = parsed; // parked after a failed store write: already mapped
    } else if (meta.source === 'PVMBG') {
      event = mapVolcanicReportToHazardEvent(parsed as never, deps.mapperVersion);
    } else if (meta.source === 'BMKG') {
      event = mapSeismicEventToHazardEvent(parsed as never, undefined);
    } else {
      throw new Error(`no replay handler for source ${meta.source}`);
    }
    floor = nextIngestedAt((deps.clock ?? Date.now)(), floor);
    await deps.writer.write({ ...event, hazard_id: hazardId(event.source, event.source_ref_id), ingested_at: event.ingested_at || floor }, `replay-${meta.message_id}`);
  };
}

export async function replayParked(deps: ReplayDeps, query: ReplayQuery): Promise<ReplayReport> {
  const report = await deps.ingest.parker.replay(query, replayHandler(deps), deps.ingest.writeCtx('replay'));
  await deps.ingest.metrics.refreshParked(deps.ingest.parker);
  return report;
}
