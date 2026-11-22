import type { HazardEvent, HazardEventResponse, HazardSource } from '../../../../shared-types/src/hazard-event';
import { compareBytes, decodeCursor, encodeCursor, hazardId, nextIngestedAt } from '../../../../shared-types/src/m2/ids';
import { FencedError, type StorageClient, type WriteCtx } from '../../../../shared-types/src/m2/types';
import { clampLimit, staleSourcesFor, type CanonicalStore, type HazardQuery, type PendingHazardPublication, type StoredHazard } from './canonical-store';
import { incCounter, METRICS } from '../resilience/obs';

interface SyncState { stale_since: string | null; last_success_at: string | null; last_ingested_at?: string | null }

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
  private readonly lastIngestedBySource = new Map<HazardSource, string>();

  constructor(private readonly opts: StorageCanonicalStoreOptions) {
    this.clock = opts.clock ?? Date.now;
  }

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  private ctx(source: HazardSource, key: string, correlationId: string, outbox?: WriteCtx['outbox']): WriteCtx {
    return { fence: this.opts.fence?.(source) ?? 1, fenceName: source.toLowerCase(), idempotencyKey: key, correlationId, outbox };
  }

  private advanceFloor(source: HazardSource, candidateIso?: string | null): void {
    if (!candidateIso) return;
    const cur = this.lastIngestedBySource.get(source);
    if (!cur || candidateIso > cur) {
      this.lastIngestedBySource.set(source, candidateIso);
    }
  }

  async upsert(event: HazardEvent, correlationId: string): Promise<StoredHazard> {
    const id = event.hazard_id || hazardId(event.source, event.source_ref_id);
    if (!this.lastIngestedBySource.has(event.source)) {
      const s = await this.readState(event.source).catch(() => null);
      this.advanceFloor(event.source, s?.last_ingested_at);
    }
    const floor = this.lastIngestedBySource.get(event.source) ?? null;
    const rawMs = event.ingested_at ? Date.parse(event.ingested_at) : this.clock();
    const monotonicIngestedAt = nextIngestedAt(Number.isFinite(rawMs) ? rawMs : this.clock(), floor);
    try {
      const existing = await this.opts.storage.getEvent(id).catch(() => ({ event: null }));
      const effectiveIngestedAt = existing.event ? existing.event.ingested_at : monotonicIngestedAt;
      if (!existing.event) {
        this.advanceFloor(event.source, monotonicIngestedAt);
      }
      const result = await this.opts.storage.upsertEvent(
        { ...event, hazard_id: id, ingested_at: effectiveIngestedAt, version: 1 },
        this.ctx(event.source, `event-${id}`, correlationId, { mode: 'on_create', priority: 'normal' }),
      );
      return { event: { ...event, hazard_id: id, ingested_at: effectiveIngestedAt }, created: result.created };
    } catch (err) {
      if (err instanceof FencedError) {
        incCounter(METRICS.fencingRejections, { name: err.fenceName });
      }
      throw err;
    }
  }

  async claimPendingPublication(): Promise<PendingHazardPublication | null> {
    throw new Error('outbox is served by OutboxDispatcher on the StorageClient');
  }
  async markPublicationSent(): Promise<void> { throw new Error('outbox is served by OutboxDispatcher on the StorageClient'); }
  async releasePublication(): Promise<void> { throw new Error('outbox is served by OutboxDispatcher on the StorageClient'); }

  async list(query: HazardQuery = {}): Promise<HazardEventResponse> {
    const limit = clampLimit(query.limit);
    const cacheKey = JSON.stringify([query.hazardType ?? null, query.source ?? null, query.since ?? null, limit, query.cursor ?? null]);
    const hit = this.cache.get(cacheKey);
    const ttl = this.opts.listCacheMs ?? 1000;
    if (hit && ttl > 0 && this.clock() - hit.at < ttl) return hit.value;

    const all: HazardEvent[] = [];
    let scanCursor: string | undefined;
    let partial = false;
    const unavailableSet = new Set<string>();
    const maxScan = this.opts.maxScan ?? 50_000;
    do {
      const page = await this.opts.storage.listEvents({
        hazardType: query.hazardType,
        source: query.source,
        limit: 1000,
        cursor: scanCursor,
      });
      all.push(...page.items);
      if (page.partial) partial = true;
      for (const u of page.unavailable_units ?? []) unavailableSet.add(u);
      scanCursor = page.next_cursor ?? undefined;
    } while (scanCursor && all.length < maxScan);

    // Deterministic newest-first ordering: (occurred_at DESC, hazard_id ASC)
    const sorted = all
      .filter((e) => !query.since || e.occurred_at >= query.since)
      .sort((a, b) => (a.occurred_at !== b.occurred_at ? (a.occurred_at < b.occurred_at ? 1 : -1) : compareBytes(a.hazard_id, b.hazard_id)));

    const afterPos = query.cursor ? decodeCursor(query.cursor) : null;
    const afterCursor = afterPos
      ? sorted.filter((e) => e.occurred_at < afterPos.t || (e.occurred_at === afterPos.t && compareBytes(e.hazard_id, afterPos.h) > 0))
      : sorted;

    const data = afterCursor.slice(0, limit);
    const hasMore = afterCursor.length > limit && data.length > 0;
    const lastItem = data[data.length - 1];
    const next_cursor = hasMore && lastItem ? encodeCursor({ t: lastItem.occurred_at, h: lastItem.hazard_id }) : null;

    const states = await Promise.all(staleSourcesFor(query.hazardType).map((s) => this.readState(s).catch(() => null)));
    const stale = states.map((s) => s?.stale_since).filter((s): s is string => !!s).sort()[0] ?? null;
    const value: HazardEventResponse = {
      data,
      meta: {
        stale_since: stale,
        next_cursor,
        ...(partial ? { partial: true, unavailable_units: [...unavailableSet] } : {}),
      },
    };
    this.cache.set(cacheKey, { at: this.clock(), value });
    return value;
  }

  private readState(source: HazardSource): Promise<SyncState | null> {
    return this.opts.storage.getDoc<SyncState>('fire_state', `source_sync:${source}`);
  }
  private async writeState(source: HazardSource, state: SyncState): Promise<void> {
    try {
      await this.opts.storage.putDoc('fire_state', `source_sync:${source}`, state, this.ctx(source, `sync-${source}`, 'source-sync'));
    } catch (err) {
      if (err instanceof FencedError) {
        incCounter(METRICS.fencingRejections, { name: err.fenceName });
      }
      throw err;
    }
  }

  async getLastSuccessAt(source: HazardSource): Promise<Date | null> {
    const s = await this.readState(source);
    this.advanceFloor(source, s?.last_ingested_at);
    return s?.last_success_at ? new Date(s.last_success_at) : null;
  }
  async markSourceFresh(source: HazardSource): Promise<void> {
    const cur = await this.readState(source).catch(() => null);
    this.advanceFloor(source, cur?.last_ingested_at);
    await this.writeState(source, {
      stale_since: null,
      last_success_at: new Date(this.clock()).toISOString(),
      last_ingested_at: this.lastIngestedBySource.get(source) ?? cur?.last_ingested_at ?? null,
    });
  }
  async markSourceStale(source: HazardSource): Promise<void> {
    const cur = await this.readState(source);
    this.advanceFloor(source, cur?.last_ingested_at);
    await this.writeState(source, {
      stale_since: cur?.stale_since ?? new Date(this.clock()).toISOString(),
      last_success_at: cur?.last_success_at ?? null,
      last_ingested_at: this.lastIngestedBySource.get(source) ?? cur?.last_ingested_at ?? null,
    });
  }
}
