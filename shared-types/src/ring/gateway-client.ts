import {
  AggQuery, AggResult, Collection, FenceToken, FencedError, HazardEvent, HazardSource, LocationInfo, OutboxItem, Page,
  RingStatus, StorageClient, StorageUnavailableError, StoredHazardEvent, UpsertResult, WriteCtx,
} from '../m2/types';

export const GATEWAY_OPS = [
  'upsertEvent', 'tombstoneEvent', 'getEvent', 'listEvents', 'aggregate', 'checksum', 'locate',
  'putDoc', 'getDoc', 'listDocs', 'deleteDoc', 'claimOutbox', 'markOutboxPublished', 'outboxPending', 'fenceBarrier', 'ringStatus',
] as const;
export type GatewayOp = (typeof GATEWAY_OPS)[number];

export interface GatewayOptions {
  baseUrl: string;
  internalServiceKey: string;
  timeoutMs?: number;
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<any> }>;
}

// StorageClient that reaches the ring through the Aggregator, the only component the NetworkPolicy lets talk to storage units.
export class GatewayStorageClient implements StorageClient {
  constructor(private readonly opts: GatewayOptions) {}

  private async call<T>(op: GatewayOp, args: unknown[]): Promise<T> {
    const url = new URL(`/internal/storage/${op}`, this.opts.baseUrl).toString();
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': this.opts.internalServiceKey },
      body: JSON.stringify({ args }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    };
    let res: { status: number; json(): Promise<any> };
    try {
      res = await (this.opts.fetchImpl ?? fetch)(url, init);
    } catch {
      throw new StorageUnavailableError(['aggregator-gateway']);
    }
    const body = await res.json().catch(() => null);
    if (res.status === 200) return body.result as T;
    if (res.status === 409 && body?.code === 'FENCED') throw new FencedError(body.fence_name, body.got, body.current);
    if (res.status === 503) throw new StorageUnavailableError(body?.unavailable_units ?? ['aggregator-gateway']);
    throw new Error(`storage gateway ${op} failed with HTTP ${res.status}`);
  }

  upsertEvent(e: StoredHazardEvent, ctx: WriteCtx): Promise<UpsertResult> { return this.call('upsertEvent', [e, ctx]); }
  tombstoneEvent(hazardId: string, version: number, ctx: WriteCtx, mergedInto?: string): Promise<{ applied: boolean }> { return this.call('tombstoneEvent', [hazardId, version, ctx, mergedInto]); }
  getEvent(hazardId: string): Promise<{ event: HazardEvent | null; partial: boolean; unavailable_units: string[] }> { return this.call('getEvent', [hazardId]); }
  listEvents(q: { source?: HazardSource; hazardType?: string; since?: string; limit: number; cursor?: string }): Promise<Page<HazardEvent>> { return this.call('listEvents', [q]); }
  aggregate(q: AggQuery): Promise<AggResult & { partial: boolean; unavailable_units: string[] }> { return this.call('aggregate', [q]); }
  checksum(source: HazardSource): Promise<{ count: number; checksum: string; as_of: string; partial: boolean; unavailable_units: string[] }> { return this.call('checksum', [source]); }
  locate(hazardId: string): Promise<{ locations: LocationInfo[]; partial: boolean; unavailable_units: string[] }> { return this.call('locate', [hazardId]); }
  putDoc(c: Collection, key: string, doc: unknown, ctx: WriteCtx, opts?: { version?: number }): Promise<void> { return this.call('putDoc', [c, key, doc, ctx, opts]); }
  getDoc<T>(c: Collection, key: string): Promise<T | null> { return this.call('getDoc', [c, key]); }
  listDocs<T>(c: Collection, q: { prefix?: string; limit: number; cursor?: string }): Promise<Page<{ key: string; doc: T }>> { return this.call('listDocs', [c, q]); }
  deleteDoc(c: Collection, key: string, ctx: WriteCtx): Promise<void> { return this.call('deleteDoc', [c, key, ctx]); }
  claimOutbox(max: number, leaseMs: number): Promise<OutboxItem[]> { return this.call('claimOutbox', [max, leaseMs]); }
  markOutboxPublished(ids: string[]): Promise<void> { return this.call('markOutboxPublished', [ids]); }
  outboxPending(): Promise<number> { return this.call('outboxPending', []); }
  fenceBarrier(name: string, token: FenceToken): Promise<void> { return this.call('fenceBarrier', [name, token]); }
  ringStatus(): Promise<RingStatus> { return this.call('ringStatus', []); }
}
