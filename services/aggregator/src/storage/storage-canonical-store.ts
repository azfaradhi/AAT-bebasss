import type { HazardEvent, HazardEventResponse, HazardSource } from '../../../../shared-types/src/hazard-event';
import { hazardId } from '../../../../shared-types/src/m2/ids';
import type { StorageClient, WriteCtx } from '../../../../shared-types/src/m2/types';
import { clampLimit, staleSourcesFor, type CanonicalStore, type HazardQuery, type PendingHazardPublication, type StoredHazard } from './canonical-store';

interface SyncState { stale_since: string | null; last_success_at: string | null }

export interface StorageCanonicalStoreOptions {
  storage: StorageClient;
  // Fence token for the poller's lease; 1 until a Coordinator supplies real tokens.
  fence?: (source: HazardSource) => number;
  clock?: () => number;
  // Upper bound on events scanned to answer one list; the ring has no occurred_at index.
  maxScan?: number;
  listCacheMs?: number;
}

// CanonicalStore over the replicated ring. Outbox publication is served by OutboxDispatcher directly on the StorageClient.
export class StorageCanonicalStore implements CanonicalStore {
  private readonly clock: () => number;
  private readonly cache = new Map<string, { at: number; value: HazardEventResponse }>();

  constructor(private readonly opts: StorageCanonicalStoreOptions) {
    this.clock = opts.clock ?? Date.now;
  }

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  private ctx(source: HazardSource, key: string, correlationId: string, outbox?: WriteCtx['outbox']): WriteCtx {
    return { fence: this.opts.fence?.(source) ?? 1, fenceName: source.toLowerCase(), idempotencyKey: key, correlationId, outbox };
  }

  async upsert(event: HazardEvent, correlationId: string): Promise<StoredHazard> {
    const id = event.hazard_id || hazardId(event.source, event.source_ref_id);
    const result = await this.opts.storage.upsertEvent({ ...event, hazard_id: id, version: 1 }, this.ctx(event.source, `event-${id}`, correlationId, { mode: 'on_create', priority: 'normal' }));
    return { event: { ...event, hazard_id: id }, created: result.created };
  }

  async claimPendingPublication(): Promise<PendingHazardPublication | null> {
    throw new Error('outbox is served by OutboxDispatcher on the StorageClient');
  }
  async markPublicationSent(): Promise<void> { throw new Error('outbox is served by OutboxDispatcher on the StorageClient'); }
  async releasePublication(): Promise<void> { throw new Error('outbox is served by OutboxDispatcher on the StorageClient'); }

  async list(query: HazardQuery = {}): Promise<HazardEventResponse> {
    const limit = clampLimit(query.limit);
    const cacheKey = JSON.stringify([query.hazardType ?? null, query.since ?? null, limit]);
    const hit = this.cache.get(cacheKey);
    const ttl = this.opts.listCacheMs ?? 1000;
    if (hit && ttl > 0 && this.clock() - hit.at < ttl) return hit.value;

    const all: HazardEvent[] = [];
    let cursor: string | undefined;
    const maxScan = this.opts.maxScan ?? 50_000;
    do {
      const page = await this.opts.storage.listEvents({ hazardType: query.hazardType, limit: 1000, cursor });
      all.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor && all.length < maxScan);

    const data = all
      .filter((e) => !query.since || e.occurred_at >= query.since)
      .sort((a, b) => (a.occurred_at === b.occurred_at ? 0 : a.occurred_at < b.occurred_at ? 1 : -1))
      .slice(0, limit);
    const states = await Promise.all(staleSourcesFor(query.hazardType).map((s) => this.readState(s)));
    const stale = states.map((s) => s?.stale_since).filter((s): s is string => !!s).sort()[0] ?? null;
    const value: HazardEventResponse = { data, meta: { stale_since: stale } };
    this.cache.set(cacheKey, { at: this.clock(), value });
    return value;
  }

  private readState(source: HazardSource): Promise<SyncState | null> {
    return this.opts.storage.getDoc<SyncState>('fire_state', `source_sync:${source}`);
  }
  private writeState(source: HazardSource, state: SyncState): Promise<void> {
    return this.opts.storage.putDoc('fire_state', `source_sync:${source}`, state, this.ctx(source, `sync-${source}`, 'source-sync'));
  }

  async getLastSuccessAt(source: HazardSource): Promise<Date | null> {
    const s = await this.readState(source);
    return s?.last_success_at ? new Date(s.last_success_at) : null;
  }
  async markSourceFresh(source: HazardSource): Promise<void> {
    await this.writeState(source, { stale_since: null, last_success_at: new Date(this.clock()).toISOString() });
  }
  async markSourceStale(source: HazardSource): Promise<void> {
    const cur = await this.readState(source);
    await this.writeState(source, { stale_since: cur?.stale_since ?? new Date(this.clock()).toISOString(), last_success_at: cur?.last_success_at ?? null });
  }
}
