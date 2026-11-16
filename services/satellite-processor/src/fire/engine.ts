import { detectionKey, detectionTimeUtc, fireId } from '../../../../shared-types/src/m2/ids';
import type { Detection } from '../../../../shared-types/src/m2/types';
import { CONNECT_KM, CONNECT_MS, cellCoords, cellKey, haversineKm } from './geo';

export type Confidence = 'l' | 'n' | 'h';

export interface Det {
  key: string;
  offset: number; // offset of the frame that produced this state (last writer wins)
  t: number; // detection time, epoch ms (UTC)
  lat: number;
  lon: number;
  confidence: Confidence;
  frp: number;
  satellite: string;
  status: 'live' | 'retracted';
}

// `snapshot` keeps the members of a fire that was changed and finalized inside the same batch, so its event is still written.
export interface FireChange { kind: 'upsert' | 'gone' | 'finalized'; offset: number; mergedInto?: string; snapshot?: Det[]; finalized?: boolean }

export interface ChangeSet {
  fires: Map<string, FireChange>;
  dets: Set<string>;
  evicted: Set<string>;
  lateLogChanged: boolean;
}

export interface LateEntry { key: string; offset: number; t: string }

export interface Counters { lateApplied: number; lateBeyond: number; frozenIgnored: number; finalizedFires: number; evictedDetections: number; singletonsEvicted: number }

const LATE_LOG_CAP = 1000;
const SCAN_STEP_MS = 5 * 60_000;
const emptyChanges = (): ChangeSet => ({ fires: new Map(), dets: new Set(), evicted: new Set(), lateLogChanged: false });

const eligible = (d: Det): boolean => d.status === 'live' && d.confidence !== 'l';

// Deterministic fold of detection / update / retract frames into fires (FIRE-1..5). Frames must arrive in offset order.
export class FireEngine {
  readonly dets = new Map<string, Det>();
  readonly fires = new Map<string, Set<string>>();
  private readonly fireOf = new Map<string, string>();
  private readonly cells = new Map<string, Set<string>>();
  private readonly latestT = new Map<string, number>();
  private changes: ChangeSet = emptyChanges();
  private maxT = Number.NEGATIVE_INFINITY;
  private lastScanWatermark = Number.NEGATIVE_INFINITY;
  readonly counters: Counters = { lateApplied: 0, lateBeyond: 0, frozenIgnored: 0, finalizedFires: 0, evictedDetections: 0, singletonsEvicted: 0 };
  readonly lateLog: LateEntry[] = [];

  constructor(private readonly latenessMs = CONNECT_MS) {}

  // Detections older than this are beyond the allowed lateness: counted, never merged.
  get watermark(): number { return this.maxT - this.latenessMs; }
  get maxEventTime(): number { return this.maxT; }

  takeChanges(): ChangeSet {
    const out = this.changes;
    this.changes = emptyChanges();
    return out;
  }

  // FIRE-5: detections that are not (yet) part of a fire, including the ones already evicted from state.
  singlesTotal(): number { return this.singletons() + this.counters.singletonsEvicted; }

  stats(): { watermark: string | null; open_fires: number; singletons: number; singles_total: number; stored_detections: number } & Counters {
    return {
      watermark: Number.isFinite(this.maxT) ? new Date(this.watermark).toISOString() : null,
      open_fires: this.fires.size, singletons: this.singletons(), singles_total: this.singlesTotal(), stored_detections: this.dets.size, ...this.counters,
    };
  }

  singletons(): number {
    let n = 0;
    for (const d of this.dets.values()) if (eligible(d) && !this.fireOf.has(d.key)) n++;
    return n;
  }

  // Rebuilds the in-memory indexes from persisted detections and fires.
  // The detections are the only authoritative state. Fires are re-derived from them (the fold is order independent), so a
  // crash between persisting detections and fire documents can never leave the two inconsistent.
  hydrate(dets: Det[], _fires: unknown, state?: { max_t: number | null; counters: Counters; late_log: LateEntry[] }): void {
    for (const d of dets) {
      this.dets.set(d.key, d);
      if (eligible(d)) this.indexAdd(d);
    }
    const seen = new Set<string>();
    for (const start of [...this.dets.keys()].sort()) {
      const d0 = this.dets.get(start)!;
      if (seen.has(start) || !eligible(d0)) continue;
      const comp: string[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const k = stack.pop()!;
        comp.push(k);
        for (const n of this.neighbours(this.dets.get(k)!)) if (!seen.has(n)) { seen.add(n); stack.push(n); }
      }
      if (comp.length < 2) continue;
      const id = fireId(comp);
      this.fires.set(id, new Set(comp));
      for (const k of comp) this.fireOf.set(k, id);
      this.latestT.set(id, Math.max(...comp.map((k) => this.dets.get(k)!.t)));
    }
    if (state) {
      this.maxT = state.max_t ?? Number.NEGATIVE_INFINITY;
      Object.assign(this.counters, state.counters);
      this.lateLog.push(...state.late_log);
    }
  }

  persistedState(): { max_t: number | null; counters: Counters } {
    return { max_t: Number.isFinite(this.maxT) ? this.maxT : null, counters: { ...this.counters } };
  }

  // A detection (or fire) that no in-bound frame can reach any more: connectivity needs |dt| <= 360 min.
  private frozen(d: Det): boolean {
    const f = this.fireOf.get(d.key);
    const latest = f ? this.latestT.get(f)! : d.t;
    return latest + CONNECT_MS < this.watermark;
  }

  // Memory only: frozen state can no longer change results, so dropping it never alters output.
  closeExpired(offset: number): void {
    const wm = this.watermark;
    if (!Number.isFinite(wm) || wm - this.lastScanWatermark < SCAN_STEP_MS) return;
    this.lastScanWatermark = wm;
    for (const [id, keys] of [...this.fires]) {
      if (this.latestT.get(id)! + CONNECT_MS >= wm) continue;
      const pending = this.changes.fires.get(id);
      const snapshot = pending?.kind === 'upsert' ? [...keys].map((k) => this.dets.get(k)!) : undefined;
      for (const k of keys) this.evict(k);
      this.fires.delete(id);
      this.latestT.delete(id);
      this.counters.finalizedFires++;
      this.changes.fires.set(id, snapshot ? { kind: 'upsert', offset: pending!.offset, snapshot, finalized: true } : { kind: 'finalized', offset });
    }
    for (const d of [...this.dets.values()]) {
      if (this.fireOf.has(d.key) || d.t + CONNECT_MS >= wm) continue;
      if (eligible(d)) this.counters.singletonsEvicted++;
      this.evict(d.key);
    }
  }

  private evict(key: string): void {
    const d = this.dets.get(key);
    if (!d) return;
    if (eligible(d)) this.indexRemove(d);
    this.dets.delete(key);
    this.fireOf.delete(key);
    this.changes.dets.delete(key);
    this.changes.evicted.add(key);
    this.counters.evictedDetections++;
  }

  detection(offset: number, raw: Detection): void {
    const key = detectionKey(raw);
    const t = Date.parse(detectionTimeUtc(raw));
    const existing = this.dets.get(key);
    if (!existing) {
      if (t < this.watermark) {
        this.counters.lateBeyond++;
        this.lateLog.push({ key, offset, t: new Date(t).toISOString() });
        if (this.lateLog.length > LATE_LOG_CAP) this.lateLog.shift();
        this.changes.lateLogChanged = true;
        return;
      }
      if (t < this.maxT) this.counters.lateApplied++;
    } else if (this.frozen(existing)) {
      this.counters.frozenIgnored++;
      return;
    }
    this.maxT = Math.max(this.maxT, t);
    const next: Det = {
      key, offset, t, lat: raw.latitude, lon: raw.longitude,
      confidence: raw.confidence, frp: raw.frp, satellite: raw.satellite, status: 'live',
    };
    this.write(next);
  }

  update(offset: number, key: string, changes: Partial<Detection>): void {
    const cur = this.dets.get(key);
    if (!cur || cur.status !== 'live' || offset <= cur.offset) return; // unknown, retracted or stale
    if (this.frozen(cur)) { this.counters.frozenIgnored++; return; }
    this.write({
      ...cur, offset,
      confidence: changes.confidence ?? cur.confidence,
      frp: changes.frp ?? cur.frp,
    });
  }

  retract(offset: number, key: string): void {
    const cur = this.dets.get(key);
    if (!cur || cur.status === 'retracted' || offset <= cur.offset) return;
    if (this.frozen(cur)) { this.counters.frozenIgnored++; return; }
    this.write({ ...cur, offset, status: 'retracted' });
  }

  private write(next: Det): void {
    const prev = this.dets.get(next.key);
    if (prev && next.offset <= prev.offset) return; // replay / stale: idempotent
    if (prev && prev.status === next.status && prev.confidence === next.confidence && prev.frp === next.frp
      && prev.t === next.t && prev.lat === next.lat && prev.lon === next.lon && prev.satellite === next.satellite) {
      this.dets.set(next.key, { ...prev, offset: next.offset }); // identical repeat: version moves, clusters do not
      this.changes.dets.add(next.key);
      return;
    }
    if (prev && eligible(prev)) this.indexRemove(prev);
    this.dets.set(next.key, next);
    this.changes.dets.add(next.key);
    if (eligible(next)) this.indexAdd(next);
    this.recluster(next.key, next.offset);
  }

  private indexAdd(d: Det): void {
    const [cx, cy] = cellCoords(d.lat, d.lon);
    const k = cellKey(cx, cy);
    (this.cells.get(k) ?? this.cells.set(k, new Set()).get(k)!).add(d.key);
  }

  private indexRemove(d: Det): void {
    const [cx, cy] = cellCoords(d.lat, d.lon);
    const k = cellKey(cx, cy);
    const set = this.cells.get(k);
    set?.delete(d.key);
    if (set && set.size === 0) this.cells.delete(k);
  }

  private neighbours(d: Det): string[] {
    const [cx, cy] = cellCoords(d.lat, d.lon);
    const out: string[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const key of this.cells.get(cellKey(cx + dx, cy + dy)) ?? []) {
          if (key === d.key) continue;
          const o = this.dets.get(key)!;
          if (Math.abs(o.t - d.t) <= CONNECT_MS && haversineKm(d.lat, d.lon, o.lat, o.lon) <= CONNECT_KM) out.push(key);
        }
      }
    }
    return out;
  }

  // Re-partitions only the fires touched by `seed`; components never cross into untouched fires.
  private recluster(seedKey: string, offset: number): void {
    const seed = this.dets.get(seedKey)!;
    const affected = new Set<string>();
    const pool = new Set<string>();
    const oldOfSeed = this.fireOf.get(seedKey);
    if (oldOfSeed) affected.add(oldOfSeed);
    if (eligible(seed)) {
      pool.add(seedKey);
      for (const n of this.neighbours(seed)) {
        pool.add(n); // singletons next to the seed may now pair up
        const f = this.fireOf.get(n);
        if (f) affected.add(f);
      }
    }
    for (const id of affected) for (const k of this.fires.get(id) ?? []) if (eligible(this.dets.get(k)!)) pool.add(k);

    const seen = new Set<string>();
    const components: string[][] = [];
    for (const start of [...pool].sort()) {
      if (seen.has(start)) continue;
      const comp: string[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const k = stack.pop()!;
        comp.push(k);
        for (const n of this.neighbours(this.dets.get(k)!)) if (pool.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
      }
      components.push(comp);
    }

    const oldKeys = new Map<string, Set<string>>();
    for (const id of affected) {
      const keys = this.fires.get(id)!;
      oldKeys.set(id, keys);
      this.fires.delete(id);
      for (const k of keys) this.fireOf.delete(k);
    }

    const newIds = new Map<string, Set<string>>();
    for (const comp of components) {
      if (comp.length < 2) continue;
      const id = fireId(comp);
      newIds.set(id, new Set(comp));
      this.fires.set(id, new Set(comp));
      for (const k of comp) this.fireOf.set(k, id);
    }

    for (const id of affected) this.latestT.delete(id);
    for (const [id, keys] of newIds) this.latestT.set(id, Math.max(...[...keys].map((k) => this.dets.get(k)!.t)));

    for (const [id, keys] of newIds) {
      const before = oldKeys.get(id);
      const unchanged = before && before.size === keys.size && [...keys].every((k) => before.has(k)) && !keys.has(seedKey);
      if (!unchanged) this.changes.fires.set(id, { kind: 'upsert', offset });
    }
    for (const [id, keys] of oldKeys) {
      if (newIds.has(id)) continue;
      const target = [...newIds.entries()].filter(([, ks]) => [...keys].some((k) => ks.has(k))).map(([nid]) => nid).sort()[0];
      this.changes.fires.set(id, { kind: 'gone', offset, mergedInto: target });
    }
  }
}
