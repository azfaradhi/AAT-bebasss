/**
 * REFERENCE FAKE of StorageClient (contract §4.1).
 */
import {
  AggQuery, AggResult, Collection, FenceToken, FencedError, HazardEvent, HazardSource, LocationInfo, OutboxItem, Page,
  RingStatus, StorageClient, StorageUnavailableError, StoredHazardEvent, UnitState, UpsertResult, WriteCtx,
} from '../types.js';
import { compareBytes, compareEvents, computeChecksum, dashboardCategory, decodeCursor, encodeCursor, isoMs, outboxMessageId } from '../ids.js';

export interface FakeStorageControls {
  setUnitState(unit: string, state: UnitState): void;
  units(): string[];
  tick(ms: number): void;
}

type Row = StoredHazardEvent & { tombstone?: true; merged_into?: string };
const UNITS = [
  { unit: 'unit-node-a', node: 'node-a' },
  { unit: 'unit-node-b', node: 'node-b' },
  { unit: 'unit-node-c', node: 'node-c' },
];
const RF = 2;

export class InMemoryStorage implements StorageClient, FakeStorageControls {
  private truth = new Map<string, Row>();
  private onUnit = new Map<string, Map<string, Row>>();
  private docsTruth = new Map<string, { doc: unknown; version: number }>();
  private state = new Map<string, UnitState>(UNITS.map((u) => [u.unit, 'STABLE']));
  private fences = new Map<string, FenceToken>();
  private outbox = new Map<string, OutboxItem & { published: boolean; leaseUntil: number }>();
  private now = Date.now();

  constructor() { for (const u of UNITS) this.onUnit.set(u.unit, new Map()); }

  setUnitState(unit: string, st: UnitState): void {
    if (!this.state.has(unit)) throw new Error(`unknown unit ${unit}`);
    this.state.set(unit, st);
    if (st === 'STABLE') for (const [id, row] of this.truth) if (this.replicasOf(id).includes(unit)) this.onUnit.get(unit)!.set(id, row);
  }
  units(): string[] { return UNITS.map((u) => u.unit); }
  tick(ms: number): void { this.now += ms; }

  private readable(unit: string): boolean { return this.state.get(unit) === 'STABLE'; }
  private replicasOf(hazardId: string): string[] {
    const p = parseInt(hazardId.replace('hz-', '').slice(0, 8), 16) % UNITS.length;
    return Array.from({ length: RF }, (_, i) => UNITS[(p + i) % UNITS.length].unit);
  }
  private unavailableUnits(): string[] { return UNITS.map((u) => u.unit).filter((u) => !this.readable(u)); }
  private partialInfo(ids?: Iterable<string>): { partial: boolean; unavailable_units: string[] } {
    const down = this.unavailableUnits();
    if (down.length === 0) return { partial: false, unavailable_units: [] };
    for (const id of ids ?? this.truth.keys()) if (this.replicasOf(id).every((u) => !this.readable(u))) return { partial: true, unavailable_units: down };
    return { partial: false, unavailable_units: [] };
  }
  private checkFence(ctx: WriteCtx): void {
    const cur = this.fences.get(ctx.fenceName) ?? 0;
    if (ctx.fence < cur) throw new FencedError(ctx.fenceName, ctx.fence, cur);
  }
  private writableReplicas(id: string): string[] {
    const up = this.replicasOf(id).filter((u) => this.state.get(u) === 'STABLE' || this.state.get(u) === 'JOINING' || this.state.get(u) === 'RECOVERING');
    const reachable = this.replicasOf(id).filter((u) => this.state.get(u) !== 'DOWN');
    if (reachable.length === 0) throw new StorageUnavailableError(this.unavailableUnits());
    return up.length ? up : reachable;
  }
  private visible(): Row[] {
    const seen = new Map<string, Row>();
    for (const [unit, m] of this.onUnit) {
      if (!this.readable(unit)) continue;
      for (const [id, row] of m) if (!row.tombstone) seen.set(id, row);
    }
    for (const [unit, m] of this.onUnit) if (this.readable(unit)) for (const [id, row] of m) if (row.tombstone) seen.delete(id);
    return [...seen.values()];
  }
  private strip(r: Row): HazardEvent {
    const { version: _v, tombstone: _t, merged_into: _m, ...e } = r;
    return e;
  }

  async upsertEvent(e: StoredHazardEvent, ctx: WriteCtx): Promise<UpsertResult> {
    this.checkFence(ctx);
    const targets = this.writableReplicas(e.hazard_id);
    const existing = this.truth.get(e.hazard_id);
    if (existing && e.version <= existing.version) return { created: false, applied: false, replicas_acked: targets.length, replicas_target: RF };
    const row: Row = { ...e, ingested_at: existing ? existing.ingested_at : e.ingested_at };
    this.truth.set(e.hazard_id, row);
    for (const u of targets) this.onUnit.get(u)!.set(e.hazard_id, row);
    const created = !existing;
    const mode = ctx.outbox?.mode ?? 'on_create';
    if (mode === 'on_apply' || (mode === 'on_create' && created)) {
      const id = outboxMessageId(e.hazard_id, e.version);
      if (!this.outbox.has(id)) {
        this.outbox.set(id, {
          message_id: id, hazard_id: e.hazard_id, event: { ...row }, priority: ctx.outbox?.priority ?? 'normal',
          correlation_id: ctx.correlationId, attempts: 0, published: false, leaseUntil: 0,
        });
      }
    }
    return { created, applied: true, replicas_acked: targets.length, replicas_target: RF };
  }
  async tombstoneEvent(hazardId: string, version: number, ctx: WriteCtx, mergedInto?: string): Promise<{ applied: boolean }> {
    this.checkFence(ctx);
    const cur = this.truth.get(hazardId);
    if (!cur || version <= cur.version) return { applied: false };
    const row: Row = { ...cur, version, tombstone: true, merged_into: mergedInto };
    this.truth.set(hazardId, row);
    for (const u of this.writableReplicas(hazardId)) this.onUnit.get(u)!.set(hazardId, row);
    return { applied: true };
  }
  async getEvent(hazardId: string): Promise<{ event: HazardEvent | null; partial: boolean; unavailable_units: string[] }> {
    const row = this.visible().find((r) => r.hazard_id === hazardId);
    if (row) return { event: this.strip(row), partial: false, unavailable_units: [] };
    const known = this.truth.get(hazardId);
    const unreachable = !!known && !known.tombstone && this.replicasOf(hazardId).every((u) => !this.readable(u));
    return { event: null, partial: unreachable, unavailable_units: unreachable ? this.unavailableUnits() : [] };
  }
  async listEvents(q: { source?: HazardSource; hazardType?: string; since?: string; limit: number; cursor?: string }): Promise<Page<HazardEvent>> {
    let rows = this.visible().filter((r) => (!q.source || r.source === q.source) && (!q.hazardType || r.hazard_type === q.hazardType) && (!q.since || r.ingested_at >= q.since));
    rows.sort(compareEvents);
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      rows = rows.filter((r) => compareEvents(r, { ingested_at: c.t, hazard_id: c.h }) > 0);
    }
    const page = rows.slice(0, q.limit);
    const more = rows.length > page.length;
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.strip(r)),
      next_cursor: more && last ? encodeCursor({ t: last.ingested_at, h: last.hazard_id }) : null,
      ...this.partialInfo(),
    };
  }
  async aggregate(q: AggQuery): Promise<AggResult & { partial: boolean; unavailable_units: string[] }> {
    const rows = this.visible().filter((r) => (!q.from || r.occurred_at >= q.from) && (!q.to || r.occurred_at < q.to));
    const buckets = new Map<string, AggResult['by_type_over_time'][number]>();
    const sev: Record<string, number> = { NORMAL: 0, WASPADA: 0, SIAGA: 0, AWAS: 0 };
    const area = new Map<string, number>();
    for (const r of rows) {
      const d = new Date(r.occurred_at);
      const b = q.bucket === 'hour' ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())) : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const key = isoMs(b);
      const cur = buckets.get(key) ?? { bucket: key, gempa: 0, tsunami: 0, gunung_berapi: 0, kebakaran_hutan: 0, pesisir: 0 };
      cur[dashboardCategory(r)] += 1;
      buckets.set(key, cur);
      sev[r.severity] += 1;
      area.set(r.area_name, (area.get(r.area_name) ?? 0) + 1);
    }
    return {
      by_type_over_time: [...buckets.values()].sort((a, b) => compareBytes(a.bucket, b.bucket)),
      by_severity: sev as AggResult['by_severity'],
      by_area: [...area.entries()].map(([area_name, count]) => ({ area_name, count })).sort((a, b) => b.count - a.count || compareBytes(a.area_name, b.area_name)),
      total: rows.length,
      ...this.partialInfo(),
    };
  }
  async checksum(source: HazardSource): Promise<{ count: number; checksum: string; as_of: string; partial: boolean; unavailable_units: string[] }> {
    const refs = this.visible().filter((r) => r.source === source).map((r) => r.source_ref_id);
    return { count: refs.length, checksum: computeChecksum(refs), as_of: isoMs(this.now), ...this.partialInfo() };
  }
  async locate(hazardId: string): Promise<{ locations: LocationInfo[]; partial: boolean; unavailable_units: string[] }> {
    const row = this.truth.get(hazardId);
    if (!row || row.tombstone) return { locations: [], partial: false, unavailable_units: [] };
    const reps = this.replicasOf(hazardId);
    const locations = reps.map((u, i) => ({ node: UNITS.find((x) => x.unit === u)!.node, unit: u, role: (i === 0 ? 'primary' : 'replica') as 'primary' | 'replica' }));
    return { locations, ...this.partialInfo([hazardId]) };
  }

  private dk(c: Collection, key: string): string { return `${c}/${key}`; }
  async putDoc(c: Collection, key: string, doc: unknown, ctx: WriteCtx, opts?: { version?: number }): Promise<void> {
    this.checkFence(ctx);
    if (this.unavailableUnits().length === UNITS.length) throw new StorageUnavailableError(this.unavailableUnits());
    const cur = this.docsTruth.get(this.dk(c, key));
    if (opts?.version !== undefined && cur && opts.version < cur.version) return;
    this.docsTruth.set(this.dk(c, key), { doc: structuredClone(doc), version: opts?.version ?? (cur?.version ?? 0) + 1 });
  }
  async getDoc<T>(c: Collection, key: string): Promise<T | null> {
    const d = this.docsTruth.get(this.dk(c, key));
    return d ? (structuredClone(d.doc) as T) : null;
  }
  async listDocs<T>(c: Collection, q: { prefix?: string; limit: number; cursor?: string }): Promise<Page<{ key: string; doc: T }>> {
    const pre = `${c}/`;
    let keys = [...this.docsTruth.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length)).filter((k) => !q.prefix || k.startsWith(q.prefix));
    keys.sort(compareBytes);
    if (q.cursor) { const after = decodeCursor(q.cursor).h; keys = keys.filter((k) => compareBytes(k, after) > 0); }
    const page = keys.slice(0, q.limit);
    return {
      items: page.map((key) => ({ key, doc: structuredClone(this.docsTruth.get(this.dk(c, key))!.doc) as T })),
      next_cursor: keys.length > page.length ? encodeCursor({ t: '', h: page[page.length - 1] }) : null,
      partial: false, unavailable_units: [],
    };
  }
  async deleteDoc(c: Collection, key: string, ctx: WriteCtx): Promise<void> { this.checkFence(ctx); this.docsTruth.delete(this.dk(c, key)); }

  async claimOutbox(max: number, leaseMs: number): Promise<OutboxItem[]> {
    const out: OutboxItem[] = [];
    for (const it of this.outbox.values()) {
      if (out.length >= max) break;
      if (it.published || it.leaseUntil > this.now) continue;
      it.leaseUntil = this.now + leaseMs;
      it.attempts += 1;
      const { published: _p, leaseUntil: _l, ...pub } = it;
      out.push({ ...pub });
    }
    return out;
  }
  async markOutboxPublished(ids: string[]): Promise<void> { for (const id of ids) { const it = this.outbox.get(id); if (it) it.published = true; } }
  async outboxPending(): Promise<number> { return [...this.outbox.values()].filter((i) => !i.published).length; }

  async fenceBarrier(name: string, token: FenceToken): Promise<void> { this.fences.set(name, Math.max(this.fences.get(name) ?? 0, token)); }
  async ringStatus(): Promise<RingStatus> {
    const healthy = UNITS.filter((u) => this.state.get(u.unit) === 'STABLE').length;
    return {
      epoch: 1, rf: RF,
      units: UNITS.map((u) => ({ unit: u.unit, node: u.node, state: this.state.get(u.unit)!, keys: this.onUnit.get(u.unit)!.size, writes_total: this.onUnit.get(u.unit)!.size })),
      redundancy_ok: healthy === UNITS.length, repairing: false, as_of: isoMs(this.now),
    };
  }
}
