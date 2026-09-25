export interface VolcanicReport {
  report_id: string;
  volcano_id: string;
  alert_level: 'Normal' | 'Waspada' | 'Siaga' | 'Awas';
  eruption_count_24h: number;
  ash_column_height_m: number;
  reported_at: string;         // ISO 8601
  confidence_level?: number;
}
