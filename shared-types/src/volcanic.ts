export interface VolcanicReport {
  report_id: string;
  volcano_id: string;
  alert_level: 'Normal' | 'Waspada' | 'Siaga' | 'Awas';
  eruption_count_24h: number;
  ash_column_height_m: number;
  reported_at: string;
  confidence_level?: number;
}
