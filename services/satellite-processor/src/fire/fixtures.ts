import type { Detection } from '../../../../shared-types/src/m2/types';
import type { SatFrame } from '../sink';

export interface DetOpts { lat: number; lon: number; sat?: string; date?: string; time?: number; conf?: 'l' | 'n' | 'h'; frp?: number }

export const detection = (o: DetOpts): Detection => ({
  version: '2.0NRT', scan: 0.4, acq_date: o.date ?? '2026-11-27', acq_time: o.time ?? 1200, bright_ti4: 330, bright_ti5: 290,
  confidence: o.conf ?? 'n', daynight: 'D', frp: o.frp ?? 5, instrument: 'VIIRS', latitude: o.lat, longitude: o.lon,
  satellite: o.sat ?? 'N', track: 0.4,
});

export const detFrame = (offset: number, o: DetOpts): SatFrame => ({ offset, kind: 'detection', data: { offset, detection: detection(o) } });
export const updateFrame = (offset: number, key: string, changes: Partial<Detection>): SatFrame => ({ offset, kind: 'update', data: { offset, key, changes } });
export const retractFrame = (offset: number, key: string): SatFrame => ({ offset, kind: 'retract', data: { offset, key, reason: 'false_positive' } });
export const keyOf = (o: DetOpts): string => `${o.sat ?? 'N'}|${o.date ?? '2026-11-27'}|${o.time ?? 1200}|${o.lat.toFixed(5)}|${o.lon.toFixed(5)}`;
