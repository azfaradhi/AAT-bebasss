import { hazardId } from '../../../../shared-types/src/m2/ids';
import { compareBytes, isoMs } from '../../../../shared-types/src/m2/ids';
import type { HazardEvent } from '../../../../shared-types/src/m2/types';
import type { Det } from './engine';
import { haversineKm } from './geo';
import { PROVINCES } from './province-reference';

const CONF_RANK = { l: 0, n: 1, h: 2 } as const;
const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

export function severityOf(count: number, totalFrp: number): HazardEvent['severity'] {
  if (count >= 20 || totalFrp >= 100) return 'AWAS';
  if (count >= 6 || totalFrp >= 30) return 'SIAGA';
  return 'WASPADA';
}

export function nearestProvince(lat: number, lon: number): string {
  let best = PROVINCES[0];
  let bestKm = Infinity;
  for (const p of PROVINCES) {
    const km = haversineKm(lat, lon, p.lat, p.lon);
    if (km < bestKm || (km === bestKm && compareBytes(p.name, best.name) < 0)) { best = p; bestKm = km; }
  }
  return best.name;
}

// FIRE-MAP. Sums run over keys in byte order (and FRP in 1/100 MW integers) so the result never depends on arrival order.
export function fireToEvent(fireIdValue: string, members: Det[], ingestedAt: string): HazardEvent {
  const sorted = [...members].sort((a, b) => compareBytes(a.key, b.key));
  const frpCenti = sorted.reduce((sum, d) => sum + Math.round(d.frp * 100), 0);
  const totalFrp = frpCenti / 100;
  const lat = round(sorted.reduce((s, d) => s + d.lat, 0) / sorted.length, 5);
  const lon = round(sorted.reduce((s, d) => s + d.lon, 0) / sorted.length, 5);
  const earliest = Math.min(...sorted.map((d) => d.t));
  const maxConf = sorted.reduce<'l' | 'n' | 'h'>((m, d) => (CONF_RANK[d.confidence] > CONF_RANK[m] ? d.confidence : m), 'n');
  return {
    hazard_id: hazardId('SATELIT', fireIdValue),
    source: 'SATELIT',
    source_ref_id: fireIdValue,
    hazard_type: 'WILDFIRE',
    severity: severityOf(sorted.length, totalFrp),
    area_name: nearestProvince(lat, lon),
    latitude: lat,
    longitude: lon,
    occurred_at: isoMs(earliest),
    ingested_at: ingestedAt,
    attributes: {
      detection_count: sorted.length,
      satellites: [...new Set(sorted.map((d) => d.satellite))].sort(compareBytes),
      max_confidence: maxConf,
      total_frp_mw: totalFrp,
      detection_keys: sorted.map((d) => d.key),
    },
  };
}
