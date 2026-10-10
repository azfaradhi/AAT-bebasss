import { SeismicEvent, TsunamiWarning } from '../../../../shared-types/src/seismic';
import { HazardEvent, Severity } from '../../../../shared-types/src/hazard-event';

export function mapSeismicEventToHazardEvent(
  event: SeismicEvent,
  relatedWarning: TsunamiWarning | undefined
): HazardEvent {
  const {
    event_id,
    region_name,
    epicenter_lat,
    epicenter_lon,
    occurred_at,
    magnitude,
    depth_km,
    potential_tsunami,
    ...rest
  } = event;

  let severity: Severity = 'NORMAL';

  if (relatedWarning) {
    if (relatedWarning.threat_level === 'Awas') severity = 'AWAS';
    else if (relatedWarning.threat_level === 'Siaga') severity = 'SIAGA';
    else if (relatedWarning.threat_level === 'Waspada') severity = 'WASPADA';
  } else {
    if (magnitude >= 6.5) severity = 'SIAGA';
    else if (magnitude >= 5.0) severity = 'WASPADA';
    else severity = 'NORMAL';
  }

  const attributes: Record<string, unknown> = {
    magnitude,
    depth_km,
    potential_tsunami,
    ...rest
  };

  if (relatedWarning) {
    attributes.tsunami_warning = relatedWarning;
  }

  return {
    hazard_id: '',
    source: 'BMKG',
    source_ref_id: event_id,
    hazard_type: 'SEISMIC',
    severity,
    area_name: region_name,
    latitude: epicenter_lat,
    longitude: epicenter_lon,
    occurred_at,
    ingested_at: new Date().toISOString(),
    attributes
  };
}
