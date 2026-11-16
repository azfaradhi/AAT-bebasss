import type { HazardEvent } from '../../../../shared-types/src/hazard-event';
import type { StorageClient, StoredHazardEvent } from '../../../../shared-types/src/m2/types';
import type { CanonicalStore } from '../storage/canonical-store';
import type { IngestContext } from './context';

// Where a recovered or freshly mapped event is stored. Writing the same event twice must change nothing.
export interface HazardWriter {
  write(event: HazardEvent, correlationId: string): Promise<void>;
}

export function storageClientWriter(storage: StorageClient, ingest: IngestContext): HazardWriter {
  return {
    async write(event, correlationId) {
      const stored = { ...event, version: 1 } as unknown as StoredHazardEvent;
      await storage.upsertEvent(stored, ingest.writeCtx(`event-${event.hazard_id}`, correlationId));
    },
  };
}

export function canonicalStoreWriter(store: CanonicalStore): HazardWriter {
  return { write: async (event, correlationId) => { await store.upsert(event, correlationId); } };
}
