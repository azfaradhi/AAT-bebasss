import type { HazardEvent, HazardSource } from '../../../../shared-types/src/hazard-event';
import type { CanonicalStore, HazardQuery, PendingHazardPublication, StoredHazard } from '../storage/canonical-store';
import type { IngestContext } from './context';

// Decorates the canonical store: an event that cannot be stored is parked as retrying instead of failing the whole poll.
export class ParkingStore implements CanonicalStore {
  constructor(private readonly inner: CanonicalStore, private readonly ingest: IngestContext) {}

  async upsert(event: HazardEvent, correlationId: string): Promise<StoredHazard> {
    try {
      return await this.inner.upsert(event, correlationId);
    } catch (err) {
      const ref = event.source_ref_id;
      await this.ingest.parker.park(
        {
          source: event.source,
          raw: Buffer.from(JSON.stringify(event)),
          reason_code: isDataError(err) ? 'CONTRACT_VIOLATION' : 'DOWNSTREAM_UNAVAILABLE',
          detail: err instanceof Error ? err.message : String(err),
          orderingKey: ref,
          correlationId,
        },
        this.ingest.writeCtx(`${event.source}:${ref}`, correlationId),
      );
      this.ingest.metrics.record(event.source, 'retrying');
      return { event, created: false };
    }
  }

  init(): Promise<void> { return this.inner.init(); }
  claimPendingPublication(leaseMs: number): Promise<PendingHazardPublication | null> { return this.inner.claimPendingPublication(leaseMs); }
  markPublicationSent(messageId: string) { return this.inner.markPublicationSent(messageId); }
  releasePublication(messageId: string) { return this.inner.releasePublication(messageId); }
  list(query?: HazardQuery) { return this.inner.list(query); }
  getLastSuccessAt(source: HazardSource) { return this.inner.getLastSuccessAt(source); }
  markSourceFresh(source: HazardSource) { return this.inner.markSourceFresh(source); }
  markSourceStale(source: HazardSource) { return this.inner.markSourceStale(source); }
  close(): Promise<void> { return this.inner.close(); }
}

// Postgres class 22 (data exception) and 23 (integrity violation) will not succeed on retry.
function isDataError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' && /^2[23]/.test(code);
}

// Retry handler for parked store failures: the parked raw bytes are the HazardEvent JSON.
export function storeRetryHandler(store: CanonicalStore): (raw: Uint8Array) => Promise<void> {
  return async (raw) => {
    const event = JSON.parse(Buffer.from(raw).toString('utf8')) as HazardEvent;
    await store.upsert(event, `retry-${event.source}-${event.source_ref_id}`);
  };
}
