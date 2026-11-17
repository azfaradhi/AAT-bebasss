export type HazardSource = 'BMKG' | 'PVMBG' | 'SATELIT' | 'SENSOR_PANTAI';
export type HazardType = 'SEISMIC' | 'VOLCANIC' | 'WILDFIRE' | 'COASTAL';
export type Severity = 'NORMAL' | 'WASPADA' | 'SIAGA' | 'AWAS';

export interface HazardEvent {
  hazard_id: string;
  source: HazardSource;
  source_ref_id: string;
  hazard_type: HazardType;
  severity: Severity;
  area_name: string;
  latitude: number;
  longitude: number;
  occurred_at: string;
  ingested_at: string;
  attributes: Record<string, unknown>;
}

export const RINGKASAN_FIELDS = [
  'hazard_id', 'source', 'hazard_type', 'severity',
  'area_name', 'occurred_at', 'ingested_at',
] as const;

export const MENTAH_ONLY_FIELDS = [
  'source_ref_id', 'latitude', 'longitude', 'attributes',
] as const;

export interface HazardEventResponse {
  data: HazardEvent[];
  meta: {
    stale_since: string | null;
    partial?: boolean;
    unavailable_units?: string[];
    next_cursor?: string | null;
  };
}
