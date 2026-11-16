// Independent reference for the satellite result: a batch computation of FIRE-1..5 and FIRE-MAP over a whole stream.
// Deliberately different from the pipeline: no incremental state, no grid index, no watermark; all pairs are compared and
// merged with an array union-find, sums are plain floats rounded at the end. It shares only the contract helpers (keys, ids,
// time parsing) and the province table, which are data and definitions, not algorithms.
import { compareBytes, detectionKey, detectionTimeUtc, fireId, hazardId } from '../../shared-types/src/m2/ids';
import type { Detection } from '../../shared-types/src/m2/types';
import { PROVINCES } from '../../services/satellite-processor/src/fire/province-reference';

export interface Frame { id: number; event: string; data: Record<string, unknown> }
export interface RefFire {
  hazard_id: string; source_ref_id: string; severity: string; area_name: string; latitude: number; longitude: number;
  occurred_at: string; detection_count: number; satellites: string[]; max_confidence: string; total_frp_mw: number; detection_keys: string[];
}
export interface RefResult { fires: RefFire[]; singles: number; eligible: number; retracted: number; stored: number }

interface Rec { key: string; t: number; lat: number; lon: number; conf: 'l' | 'n' | 'h'; frp: number; sat: string; live: boolean }

const R = 6371.0088;
const toRad = (d: number) => (d * Math.PI) / 180;
// atan2 form of the great-circle distance (the pipeline uses the asin form)
function distKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const p1 = toRad(aLat), p2 = toRad(bLat), dp = toRad(bLat - aLat), dl = toRad(bLon - aLon);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function referenceFires(frames: Frame[]): RefResult {
  const recs = new Map<string, Rec>();
  for (const f of [...frames].sort((a, b) => a.id - b.id)) {
    if (f.event === 'detection') {
      const d = f.data.detection as Detection;
      const key = detectionKey(d);
      recs.set(key, { key, t: Date.parse(detectionTimeUtc(d)), lat: d.latitude, lon: d.longitude, conf: d.confidence, frp: d.frp, sat: d.satellite, live: true });
    } else if (f.event === 'update') {
      const r = recs.get(f.data.key as string);
      const ch = f.data.changes as Partial<Detection>;
      if (r && r.live) { if (ch.confidence) r.conf = ch.confidence; if (ch.frp !== undefined) r.frp = ch.frp; }
    } else if (f.event === 'retract') {
      const r = recs.get(f.data.key as string);
      if (r) r.live = false;
    }
  }
  const el = [...recs.values()].filter((r) => r.live && r.conf !== 'l').sort((a, b) => compareBytes(a.key, b.key));
  const parent = el.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < el.length; i++) {
    for (let j = i + 1; j < el.length; j++) {
      if (Math.abs(el[i].t - el[j].t) <= 360 * 60_000 && distKm(el[i].lat, el[i].lon, el[j].lat, el[j].lon) <= 1.0) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Rec[]>();
  el.forEach((r, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(r));

  const fires: RefFire[] = [];
  let singles = 0;
  for (const members of groups.values()) {
    if (members.length < 2) { singles++; continue; }
    const keys = members.map((m) => m.key).sort(compareBytes);
    const id = fireId(keys);
    const frp = members.reduce((s, m) => s + m.frp, 0);
    const lat = members.reduce((s, m) => s + m.lat, 0) / members.length;
    const lon = members.reduce((s, m) => s + m.lon, 0) / members.length;
    const total = Math.round(frp * 100) / 100;
    let nearest = PROVINCES[0], best = Infinity;
    for (const p of PROVINCES) { const km = distKm(Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, p.lat, p.lon); if (km < best) { best = km; nearest = p; } }
    fires.push({
      hazard_id: hazardId('SATELIT', id), source_ref_id: id,
      severity: members.length >= 20 || total >= 100 ? 'AWAS' : members.length >= 6 || total >= 30 ? 'SIAGA' : 'WASPADA',
      area_name: nearest.name, latitude: Math.round(lat * 1e5) / 1e5, longitude: Math.round(lon * 1e5) / 1e5,
      occurred_at: new Date(Math.min(...members.map((m) => m.t))).toISOString(),
      detection_count: members.length, satellites: [...new Set(members.map((m) => m.sat))].sort(compareBytes),
      max_confidence: members.some((m) => m.conf === 'h') ? 'h' : 'n', total_frp_mw: total, detection_keys: keys,
    });
  }
  fires.sort((a, b) => compareBytes(a.source_ref_id, b.source_ref_id));
  return { fires, singles, eligible: el.length, retracted: [...recs.values()].filter((r) => !r.live).length, stored: recs.size };
}
