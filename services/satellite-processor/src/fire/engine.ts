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

export interface FireChange { kind: 'upsert' | 'gone'; offset: number; mergedInto?: string }

export interface ChangeSet {
  fires: Map<string, FireChange>;
  dets: Set<string>;
}

const eligible = (d: Det): boolean => d.status === 'live' && d.confidence !== 'l';

// Deterministic fold of detection / update / retract frames into fires (FIRE-1..5). Frames must arrive in offset order.
export class FireEngine {
  readonly dets = new Map<string, Det>();
  readonly fires = new Map<string, Set<string>>();
  private readonly fireOf = new Map<string, string>();
  private readonly cells = new Map<string, Set<string>>();
  private changes: ChangeSet = { fires: new Map(), dets: new Set() };

  takeChanges(): ChangeSet {
    const out = this.changes;
    this.changes = { fires: new Map(), dets: new Set() };
    return out;
  }

  singletons(): number {
    let n = 0;
    for (const d of this.dets.values()) if (eligible(d) && !this.fireOf.has(d.key)) n++;
    return n;
  }

  // Rebuilds the in-memory indexes from persisted detections and fires.
  hydrate(dets: Det[], fires: Array<{ id: string; keys: string[] }>): void {
    for (const d of dets) {
      this.dets.set(d.key, d);
      if (eligible(d)) this.indexAdd(d);
    }
    for (const f of fires) {
      this.fires.set(f.id, new Set(f.keys));
      for (const k of f.keys) this.fireOf.set(k, f.id);
    }
  }

  detection(offset: number, raw: Detection): void {
    const key = detectionKey(raw);
    const next: Det = {
      key, offset, t: Date.parse(detectionTimeUtc(raw)), lat: raw.latitude, lon: raw.longitude,
      confidence: raw.confidence, frp: raw.frp, satellite: raw.satellite, status: 'live',
    };
    this.write(next);
  }

  update(offset: number, key: string, changes: Partial<Detection>): void {
    const cur = this.dets.get(key);
    if (!cur || cur.status !== 'live' || offset <= cur.offset) return; // unknown, retracted or stale
    this.write({
      ...cur, offset,
      confidence: changes.confidence ?? cur.confidence,
      frp: changes.frp ?? cur.frp,
    });
  }

  retract(offset: number, key: string): void {
    const cur = this.dets.get(key);
    if (!cur || cur.status === 'retracted' || offset <= cur.offset) return;
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
