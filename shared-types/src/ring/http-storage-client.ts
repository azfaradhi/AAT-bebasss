import {
  AggQuery, AggResult, Collection, FenceToken, FencedError, HazardEvent, HazardSource, LocationInfo, OutboxItem, Page,
  RingStatus, StorageClient, StorageUnavailableError, StoredHazardEvent, UnitState, UpsertResult, WriteCtx,
} from '../m2/types';
import { compareBytes, compareEvents, computeChecksum, dashboardCategory, decodeCursor, encodeCursor, isoMs } from '../m2/ids';
import type { UnitDocEntry, UnitDump, UnitIdentity, UnitRow, UnitStats } from './protocol';
import { Ring } from './ring';

export interface UnitInfo { unit: string; node: string; url: string }
export type UnitFetch = (u: UnitInfo, method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

export interface HttpStorageOptions {
  units: UnitInfo[];
  rf?: number;
  vnodes?: number;
  fetchUnit?: UnitFetch;
  timeoutMs?: number;
  // How long a unit state observation is reused; 0 re-checks on every operation.
  stateTtlMs?: number;
  now?: () => number;
}

const fetchUnitDefault = (timeoutMs: number): UnitFetch => async (u, method, path, body) => {
  const res = await fetch(new URL(path, u.url), {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const strip = (r: UnitRow): HazardEvent => {
  const { version: _v, tombstone: _t, merged_into: _m, ...e } = r;
  return e;
};
const newest = <T extends { version: number }>(a: T | undefined, b: T): T => (a && a.version >= b.version ? a : b);

export class HttpStorageClient implements StorageClient {
  private ring: Ring;
  private readonly byName = new Map<string, UnitInfo>();
  private readonly call: UnitFetch;
  private readonly ttl: number;
  private readonly now: () => number;
  private cache: { at: number; states: Map<string, UnitState> } | null = null;
  private repairing = false;

  constructor(private readonly opts: HttpStorageOptions) {
    for (const u of opts.units) this.byName.set(u.unit, u);
    this.ring = new Ring(opts.units.map((u) => u.unit), opts.rf ?? 2, opts.vnodes ?? 64, (u) => this.byName.get(u)?.node ?? u);
    this.call = opts.fetchUnit ?? fetchUnitDefault(opts.timeoutMs ?? 2000);
    this.ttl = opts.stateTtlMs ?? 1000;
    this.now = opts.now ?? Date.now;
  }

  get rf(): number { return Math.min(this.opts.rf ?? 2, this.opts.units.length); }

  get unitNames(): string[] { return this.opts.units.map((u) => u.unit); }

  // Live membership: adds units that are not known yet (it never removes one, a down unit must stay in the ring and be repaired).
  // A new unit is JOINING, so it takes writes but is not read until repair() has copied what it owns; at RF=2 at least one previous owner of every key remains.
  addUnits(extra: UnitInfo[]): string[] {
    const fresh = extra.filter((u) => !this.byName.has(u.unit));
    if (fresh.length === 0) return [];
    const units = [...this.opts.units, ...fresh].sort((a, b) => a.unit.localeCompare(b.unit));
    for (const u of fresh) this.byName.set(u.unit, u);
    this.opts.units = units;
    this.ring = new Ring(units.map((u) => u.unit), this.opts.rf ?? 2, this.opts.vnodes ?? 64, (u) => this.byName.get(u)?.node ?? u);
    this.invalidate();
    return fresh.map((u) => u.unit);
  }

  /* unit state and plumbing */
  private async states(): Promise<Map<string, UnitState>> {
    const t = this.now();
    if (this.cache && this.ttl > 0 && t - this.cache.at < this.ttl) return this.cache.states;
    const entries = await Promise.all(this.opts.units.map(async (u): Promise<[string, UnitState]> => {
      try {
        const r = await this.call(u, 'GET', '/u/identity');
        return [u.unit, r.status === 200 ? (r.body as UnitIdentity).state : 'DOWN'];
      } catch { return [u.unit, 'DOWN']; }
    }));
    this.cache = { at: t, states: new Map(entries) };
    return this.cache.states;
  }
  private invalidate(): void { this.cache = null; }
  private async send(unit: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any } | null> {
    try { return await this.call(this.byName.get(unit)!, method, path, body); } catch { return null; }
  }
  private notStable(st: Map<string, UnitState>): string[] {
    return this.opts.units.map((u) => u.unit).filter((u) => st.get(u) !== 'STABLE');
  }
  // True when some key could have every replica unreadable (all replicas of some ring arc are not STABLE).
  private partialInfo(st: Map<string, UnitState>): { partial: boolean; unavailable_units: string[] } {
    const bad = new Set(this.notStable(st));
    if (bad.size === 0) return { partial: false, unavailable_units: [] };
    const risky = this.ring.replicaSets().some((set) => set.every((u) => bad.has(u)));
    return risky ? { partial: true, unavailable_units: [...bad] } : { partial: false, unavailable_units: [] };
  }
  private readableUnits(st: Map<string, UnitState>): string[] { return this.opts.units.map((u) => u.unit).filter((u) => st.get(u) === 'STABLE'); }
  private writeTargets(replicas: string[], st: Map<string, UnitState>): string[] {
    const targets = replicas.filter((u) => st.get(u) !== 'DOWN');
    if (targets.length === 0) throw new StorageUnavailableError(this.notStable(st));
    return targets;
  }
  private fencedOrNull(r: { status: number; body: any } | null): FencedError | null {
    return r && r.status === 409 && r.body?.code === 'FENCED' ? new FencedError(r.body.fence_name, r.body.got, r.body.current) : null;
  }
  private ctxBody(ctx: WriteCtx): { fence: number; fenceName: string } { return { fence: ctx.fence, fenceName: ctx.fenceName }; }

  /* events */
  async upsertEvent(e: StoredHazardEvent, ctx: WriteCtx): Promise<UpsertResult> {
    const st = await this.states();
    const targets = this.writeTargets(this.ring.replicas(e.hazard_id), st);
    const body = { row: e, ctx: this.ctxBody(ctx), outbox: { mode: ctx.outbox?.mode ?? 'on_create', priority: ctx.outbox?.priority, correlation_id: ctx.correlationId } };
    const res = await Promise.all(targets.map((u) => this.send(u, 'POST', '/u/events', body)));
    for (const r of res) { const f = this.fencedOrNull(r); if (f) throw f; }
    const ok = res.filter((r) => r && r.status === 200).map((r) => r!.body as { created: boolean; applied: boolean });
    if (ok.length === 0) { this.invalidate(); throw new StorageUnavailableError(this.notStable(st)); }
    return { created: ok.every((r) => r.created), applied: ok.some((r) => r.applied), replicas_acked: ok.length, replicas_target: this.rf };
  }
  async tombstoneEvent(hazardId: string, version: number, ctx: WriteCtx, mergedInto?: string): Promise<{ applied: boolean }> {
    const st = await this.states();
    const targets = this.writeTargets(this.ring.replicas(hazardId), st);
    const res = await Promise.all(targets.map((u) => this.send(u, 'POST', '/u/events/tombstone', { hazard_id: hazardId, version, merged_into: mergedInto, ctx: this.ctxBody(ctx) })));
    for (const r of res) { const f = this.fencedOrNull(r); if (f) throw f; }
    const ok = res.filter((r) => r && r.status === 200);
    if (ok.length === 0) throw new StorageUnavailableError(this.notStable(st));
    return { applied: ok.some((r) => r!.body.applied) };
  }
  private async rowFrom(hazardId: string, st: Map<string, UnitState>): Promise<{ row: UnitRow | undefined; unreadable: boolean }> {
    const replicas = this.ring.replicas(hazardId);
    const readable = replicas.filter((u) => st.get(u) === 'STABLE');
    const res = await Promise.all(readable.map((u) => this.send(u, 'GET', `/u/events/${encodeURIComponent(hazardId)}`)));
    let row: UnitRow | undefined;
    for (const r of res) if (r && r.status === 200 && r.body.row) row = newest(row, r.body.row as UnitRow);
    return { row, unreadable: readable.length < replicas.length };
  }
  async getEvent(hazardId: string): Promise<{ event: HazardEvent | null; partial: boolean; unavailable_units: string[] }> {
    const st = await this.states();
    const { row, unreadable } = await this.rowFrom(hazardId, st);
    if (row && !row.tombstone) return { event: strip(row), partial: false, unavailable_units: [] };
    if (!row && unreadable) return { event: null, partial: true, unavailable_units: this.notStable(st) };
    return { event: null, partial: false, unavailable_units: [] };
  }
  async listEvents(q: { source?: HazardSource; hazardType?: string; since?: string; limit: number; cursor?: string }): Promise<Page<HazardEvent>> {
    const st = await this.states();
    const readable = this.readableUnits(st);
    let after = q.cursor ? decodeCursor(q.cursor) : null;
    const out: UnitRow[] = [];
    for (;;) {
      const fetchLimit = q.limit + 1 - out.length;
      const qs = new URLSearchParams({ limit: String(fetchLimit) });
      if (q.source) qs.set('source', q.source);
      if (q.hazardType) qs.set('hazard_type', q.hazardType);
      if (q.since) qs.set('since', q.since);
      if (after) { qs.set('after_t', after.t); qs.set('after_h', after.h); }
      const pages = await Promise.all(readable.map((u) => this.send(u, 'GET', `/u/events?${qs}`)));
      const merged = new Map<string, UnitRow>();
      let horizon: UnitRow | null = null;
      let exhausted = true;
      for (const p of pages) {
        if (!p || p.status !== 200) continue;
        const rows = p.body.rows as UnitRow[];
        for (const r of rows) merged.set(r.hazard_id, newest(merged.get(r.hazard_id), r));
        if (rows.length >= fetchLimit) {
          exhausted = false;
          const last = rows[rows.length - 1];
          if (!horizon || compareEvents(last, horizon) < 0) horizon = last;
        }
      }
      const ordered = [...merged.values()].sort(compareEvents).filter((r) => !horizon || compareEvents(r, horizon) <= 0);
      for (const r of ordered) if (!r.tombstone) out.push(r);
      if (out.length > q.limit || exhausted || ordered.length === 0) break;
      const last = ordered[ordered.length - 1];
      after = { t: last.ingested_at, h: last.hazard_id };
    }
    const items = out.slice(0, q.limit);
    const last = items[items.length - 1];
    return { items: items.map(strip), next_cursor: out.length > q.limit && last ? encodeCursor({ t: last.ingested_at, h: last.hazard_id }) : null, ...this.partialInfo(st) };
  }
  private async scan(st: Map<string, UnitState>, source?: HazardSource): Promise<UnitRow[]> {
    const qs = source ? `?source=${source}` : '';
    const res = await Promise.all(this.readableUnits(st).map((u) => this.send(u, 'GET', `/u/scan${qs}`)));
    const merged = new Map<string, UnitRow>();
    for (const r of res) if (r && r.status === 200) for (const row of r.body.rows as UnitRow[]) merged.set(row.hazard_id, newest(merged.get(row.hazard_id), row));
    return [...merged.values()].filter((r) => !r.tombstone);
  }
  async aggregate(q: AggQuery): Promise<AggResult & { partial: boolean; unavailable_units: string[] }> {
    const st = await this.states();
    const rows = (await this.scan(st)).filter((r) => (!q.from || r.occurred_at >= q.from) && (!q.to || r.occurred_at < q.to));
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
      ...this.partialInfo(st),
    };
  }
  async checksum(source: HazardSource): Promise<{ count: number; checksum: string; as_of: string; partial: boolean; unavailable_units: string[] }> {
    const st = await this.states();
    const refs = (await this.scan(st, source)).map((r) => r.source_ref_id);
    return { count: refs.length, checksum: computeChecksum(refs), as_of: isoMs(this.now()), ...this.partialInfo(st) };
  }
  async locate(hazardId: string): Promise<{ locations: LocationInfo[]; partial: boolean; unavailable_units: string[] }> {
    const st = await this.states();
    const { row } = await this.rowFrom(hazardId, st);
    if (!row || row.tombstone) return { locations: [], partial: false, unavailable_units: [] };
    const locations = this.ring.replicas(hazardId).map((u, i) => ({ node: this.byName.get(u)!.node, unit: u, role: (i === 0 ? 'primary' : 'replica') as 'primary' | 'replica' }));
    return { locations, partial: false, unavailable_units: [] };
  }

  /* docs */
  private dk(c: Collection, key: string): string { return `${c}/${key}`; }
  async putDoc(c: Collection, key: string, doc: unknown, ctx: WriteCtx, opts?: { version?: number }): Promise<void> {
    const st = await this.states();
    const targets = this.writeTargets(this.ring.replicas(this.dk(c, key)), st);
    const res = await Promise.all(targets.map((u) => this.send(u, 'PUT', `/u/docs/${c}/${encodeURIComponent(key)}`, { doc, version: opts?.version, ctx: this.ctxBody(ctx) })));
    for (const r of res) { const f = this.fencedOrNull(r); if (f) throw f; }
    if (!res.some((r) => r && r.status === 200)) throw new StorageUnavailableError(this.notStable(st));
  }
  private async docFrom(c: Collection, key: string): Promise<UnitDocEntry | undefined> {
    const st = await this.states();
    const replicas = this.ring.replicas(this.dk(c, key));
    const readable = replicas.filter((u) => st.get(u) === 'STABLE');
    if (readable.length === 0) throw new StorageUnavailableError(replicas);
    const res = await Promise.all(readable.map((u) => this.send(u, 'GET', `/u/docs/${c}/${encodeURIComponent(key)}`)));
    let best: UnitDocEntry | undefined;
    for (const r of res) if (r && r.status === 200 && r.body.entry) best = newest(best, r.body.entry as UnitDocEntry);
    return best;
  }
  async getDoc<T>(c: Collection, key: string): Promise<T | null> {
    const e = await this.docFrom(c, key);
    return e && !e.deleted ? (e.doc as T) : null;
  }
  async listDocs<T>(c: Collection, q: { prefix?: string; limit: number; cursor?: string }): Promise<Page<{ key: string; doc: T }>> {
    const st = await this.states();
    const readable = this.readableUnits(st);
    let after = q.cursor ? decodeCursor(q.cursor).h : null;
    const out: UnitDocEntry[] = [];
    for (;;) {
      const fetchLimit = q.limit + 1 - out.length;
      const qs = new URLSearchParams({ limit: String(fetchLimit) });
      if (q.prefix) qs.set('prefix', q.prefix);
      if (after !== null) qs.set('after', after);
      const pages = await Promise.all(readable.map((u) => this.send(u, 'GET', `/u/docs/${c}?${qs}`)));
      const merged = new Map<string, UnitDocEntry>();
      let horizon: string | null = null;
      let exhausted = true;
      for (const p of pages) {
        if (!p || p.status !== 200) continue;
        const entries = p.body.entries as UnitDocEntry[];
        for (const e of entries) merged.set(e.key, newest(merged.get(e.key), e));
        if (entries.length >= fetchLimit) {
          exhausted = false;
          const last = entries[entries.length - 1].key;
          if (horizon === null || compareBytes(last, horizon) < 0) horizon = last;
        }
      }
      const ordered = [...merged.values()].sort((a, b) => compareBytes(a.key, b.key)).filter((e) => horizon === null || compareBytes(e.key, horizon) <= 0);
      for (const e of ordered) if (!e.deleted) out.push(e);
      if (out.length > q.limit || exhausted || ordered.length === 0) break;
      after = ordered[ordered.length - 1].key;
    }
    const page = out.slice(0, q.limit);
    return {
      items: page.map((e) => ({ key: e.key, doc: e.doc as T })),
      next_cursor: out.length > q.limit && page.length ? encodeCursor({ t: '', h: page[page.length - 1].key }) : null,
      ...this.partialInfo(st),
    };
  }
  async deleteDoc(c: Collection, key: string, ctx: WriteCtx): Promise<void> {
    const st = await this.states();
    const targets = this.writeTargets(this.ring.replicas(this.dk(c, key)), st);
    const res = await Promise.all(targets.map((u) => this.send(u, 'POST', `/u/docs/${c}/${encodeURIComponent(key)}/delete`, { ctx: this.ctxBody(ctx) })));
    for (const r of res) { const f = this.fencedOrNull(r); if (f) throw f; }
    if (!res.some((r) => r && r.status === 200)) throw new StorageUnavailableError(this.notStable(st));
  }

  /* outbox */
  async claimOutbox(max: number, leaseMs: number): Promise<OutboxItem[]> {
    const st = await this.states();
    const out = new Map<string, OutboxItem>();
    for (const u of this.readableUnits(st)) {
      if (out.size >= max) break;
      const r = await this.send(u, 'POST', '/u/outbox/claim', { max: max - out.size, leaseMs });
      if (r && r.status === 200) for (const it of r.body.items as OutboxItem[]) if (!out.has(it.message_id)) out.set(it.message_id, it);
    }
    return [...out.values()].slice(0, max);
  }
  async markOutboxPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const st = await this.states();
    await Promise.all(this.opts.units.filter((u) => st.get(u.unit) !== 'DOWN').map((u) => this.send(u.unit, 'POST', '/u/outbox/published', { ids })));
  }
  async outboxPending(): Promise<number> {
    const st = await this.states();
    const pending = new Set<string>();
    const res = await Promise.all(this.readableUnits(st).map((u) => this.send(u, 'GET', '/u/outbox/pending')));
    for (const r of res) if (r && r.status === 200) for (const id of r.body.ids as string[]) pending.add(id);
    return pending.size;
  }

  /* fencing, ring status, repair */
  async fenceBarrier(name: string, token: FenceToken): Promise<void> {
    const st = await this.states();
    const targets = this.opts.units.map((u) => u.unit).filter((u) => st.get(u) !== 'DOWN');
    if (targets.length === 0) throw new StorageUnavailableError(this.notStable(st));
    const res = await Promise.all(targets.map((u) => this.send(u, 'POST', '/u/fence', { name, token })));
    if (!res.some((r) => r && r.status === 200)) throw new StorageUnavailableError(this.notStable(st));
  }
  async ringStatus(): Promise<RingStatus> {
    const st = await this.states();
    const stats = await Promise.all(this.opts.units.map(async (u) => {
      const r = await this.send(u.unit, 'GET', '/u/stats');
      return r && r.status === 200 ? (r.body as UnitStats) : { keys: 0, writes_total: 0 };
    }));
    return {
      epoch: 1, rf: this.rf,
      units: this.opts.units.map((u, i) => ({ unit: u.unit, node: u.node, state: st.get(u.unit)!, keys: stats[i].keys, writes_total: stats[i].writes_total })),
      redundancy_ok: this.notStable(st).length === 0,
      repairing: this.repairing,
      as_of: isoMs(this.now()),
    };
  }

  // Anti-entropy: copies the keys a RECOVERING or JOINING unit owns from healthy peers, then marks it STABLE.
  async repair(): Promise<{ repaired: string[] }> {
    this.invalidate();
    const st = await this.states();
    const targets = this.opts.units.map((u) => u.unit).filter((u) => st.get(u) === 'RECOVERING' || st.get(u) === 'JOINING');
    if (targets.length === 0) return { repaired: [] };
    let sources = this.readableUnits(st);
    if (sources.length === 0) sources = targets; // cold start: nobody is authoritative, so merge everyone
    this.repairing = true;
    try {
      const dumps = (await Promise.all(sources.map((u) => this.send(u, 'GET', '/u/dump')))).filter((r) => r && r.status === 200).map((r) => r!.body as UnitDump);
      const rows = new Map<string, UnitRow>();
      const docs = new Map<string, UnitDump['docs'][number]>();
      const fences: Record<string, number> = {};
      for (const d of dumps) {
        for (const r of d.rows) rows.set(r.hazard_id, newest(rows.get(r.hazard_id), r));
        for (const e of d.docs) docs.set(`${e.collection}/${e.key}`, newest(docs.get(`${e.collection}/${e.key}`), e));
        for (const [n, t] of Object.entries(d.fences)) fences[n] = Math.max(fences[n] ?? 0, t);
      }
      const repaired: string[] = [];
      for (const target of targets) {
        const mine = {
          rows: [...rows.values()].filter((r) => this.ring.replicas(r.hazard_id).includes(target)),
          docs: [...docs.entries()].filter(([k]) => this.ring.replicas(k).includes(target)).map(([, e]) => e),
          fences,
        };
        const applied = await this.send(target, 'POST', '/u/apply', mine);
        if (applied && applied.status === 200 && (await this.send(target, 'POST', '/u/state', { state: 'STABLE' }))?.status === 200) repaired.push(target);
      }
      return { repaired };
    } finally {
      this.repairing = false;
      this.invalidate();
    }
  }
}
