export interface SeismicEvent {
  event_id: string;
  magnitude: number;
  depth_km: number;
  epicenter_lat: number;
  epicenter_lon: number;
  region_name: string;
  occurred_at: string;
  potential_tsunami: boolean;
}

export interface TsunamiWarning {
  warning_id: string;
  related_event_id: string;
  threat_level: 'Waspada' | 'Siaga' | 'Awas';
  affected_zones: string[];
  estimated_arrival: string;
}
