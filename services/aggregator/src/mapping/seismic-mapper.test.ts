import { describe, expect, it } from 'vitest';
import type { SeismicEvent, TsunamiWarning } from '../../../../shared-types/src/seismic';
import { mapSeismicEventToHazardEvent } from './seismic-mapper';

const baseEvent: SeismicEvent = {
  event_id: 'bmkg-1',
  magnitude: 4.9,
  depth_km: 10,
  epicenter_lat: -6.2,
  epicenter_lon: 106.8,
  region_name: 'Region X',
  occurred_at: '2026-10-06T10:00:00.000Z',
  potential_tsunami: false,
};

function warning(threat_level: TsunamiWarning['threat_level']): TsunamiWarning {
  return {
    warning_id: 'w-1',
    related_event_id: 'bmkg-1',
    threat_level,
    affected_zones: ['Zone A'],
    estimated_arrival: '2026-10-06T12:00:00.000Z',
  };
}

describe('mapSeismicEventToHazardEvent severity', () => {
  it('maps magnitude below 5.0 to NORMAL when there is no warning', () => {
    expect(mapSeismicEventToHazardEvent(baseEvent, undefined).severity).toBe('NORMAL');
  });

  it('maps 5.0 up to 6.4 to WASPADA when there is no warning', () => {
    expect(mapSeismicEventToHazardEvent({ ...baseEvent, magnitude: 5.0 }, undefined).severity).toBe('WASPADA');
    expect(mapSeismicEventToHazardEvent({ ...baseEvent, magnitude: 6.4 }, undefined).severity).toBe('WASPADA');
  });

  it('maps 6.5 and above to SIAGA when there is no warning', () => {
    expect(mapSeismicEventToHazardEvent({ ...baseEvent, magnitude: 6.5 }, undefined).severity).toBe('SIAGA');
  });

  it('lets a related Awas warning override a low magnitude', () => {
    expect(mapSeismicEventToHazardEvent(baseEvent, warning('Awas')).severity).toBe('AWAS');
  });

  it('follows the threat level of a related warning instead of the magnitude', () => {
    expect(mapSeismicEventToHazardEvent({ ...baseEvent, magnitude: 7.2 }, warning('Waspada')).severity).toBe('WASPADA');
  });
});

describe('mapSeismicEventToHazardEvent fields', () => {
  it('maps the canonical fields and keeps the source reference', () => {
    const mapped = mapSeismicEventToHazardEvent(baseEvent, undefined);
    expect(mapped).toMatchObject({
      source: 'BMKG',
      source_ref_id: 'bmkg-1',
      hazard_type: 'SEISMIC',
      area_name: 'Region X',
      latitude: -6.2,
      longitude: 106.8,
      occurred_at: '2026-10-06T10:00:00.000Z',
    });
  });

  it('forwards unknown source fields into attributes without dropping them', () => {
    const event = { ...baseEvent, future_field: 'new' } as SeismicEvent & { future_field: string };
    const mapped = mapSeismicEventToHazardEvent(event, undefined);
    expect(mapped.attributes).toMatchObject({ magnitude: 4.9, depth_km: 10, potential_tsunami: false, future_field: 'new' });
    expect(mapped.attributes).not.toHaveProperty('region_name');
  });
});
