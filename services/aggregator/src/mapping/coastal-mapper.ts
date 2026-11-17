/**
 * COASTAL Hazard Mapper for Sensor Pantai observations (MB3-T08, CONTRACT-MEMBER-3.md §5.2)
 */
import type {
  PantaiObservation,
  PantaiStation,
  Severity,
  StoredHazardEvent,
} from '../../../../shared-types/src/m2/types';
import { hazardId } from '../../../../shared-types/src/m2/ids';

export function deriveCoastalSeverity(obs: Pick<PantaiObservation, 'critical' | 'sea_level_anomaly_m' | 'wave_height_m'>): Severity {
  if (obs.critical === true) {
    return 'AWAS';
  }
  if (obs.sea_level_anomaly_m >= 1.0 || obs.wave_height_m >= 4.0) {
    return 'SIAGA';
  }
  if (obs.sea_level_anomaly_m >= 0.5 || obs.wave_height_m >= 2.5) {
    return 'WASPADA';
  }
  return 'NORMAL';
}

export function mapCoastalObservation(
  obs: PantaiObservation,
  station: PantaiStation,
  ingestedAt: string,
): StoredHazardEvent {
  return {
    hazard_id: hazardId('SENSOR_PANTAI', obs.observation_id),
    source: 'SENSOR_PANTAI',
    source_ref_id: obs.observation_id,
    hazard_type: 'COASTAL',
    severity: deriveCoastalSeverity(obs),
    area_name: `${station.name}, ${station.province}`,
    latitude: station.latitude,
    longitude: station.longitude,
    occurred_at: new Date(Date.parse(obs.observed_at)).toISOString(),
    ingested_at: ingestedAt,
    version: 1,
    attributes: {
      station_id: obs.station_id,
      station_name: station.name,
      province: station.province,
      sea_level_anomaly_m: obs.sea_level_anomaly_m,
      wave_height_m: obs.wave_height_m,
      quality: obs.quality,
      critical: obs.critical,
    },
  };
}
