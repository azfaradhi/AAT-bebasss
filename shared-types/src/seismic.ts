export interface SeismicEvent {
  event_id: string;
  magnitude: number;
  depth_km: number;
  epicenter_lat: number;
  epicenter_lon: number;
  region_name: string;
  occurred_at: string;       // ISO 8601
  potential_tsunami: boolean;
}

export interface TsunamiWarning {
  warning_id: string;
  related_event_id: string;  // FK -> SeismicEvent.event_id
  threat_level: 'Waspada' | 'Siaga' | 'Awas';
  affected_zones: string[];
  estimated_arrival: string; // ISO 8601
}
