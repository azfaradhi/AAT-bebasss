import { VolcanicReport } from '../../../../shared-types/src/volcanic';
import { HazardEvent, Severity } from '../../../../shared-types/src/hazard-event';
import { VOLCANO_REFERENCE } from './volcano-reference';

export function mapVolcanicReportToHazardEvent(
  report: VolcanicReport
): HazardEvent {
  const {
    report_id,
    volcano_id,
    alert_level,
    eruption_count_24h,
    ash_column_height_m,
    reported_at,
    ...rest
  } = report;

  let severity: Severity = 'NORMAL';
  if (alert_level === 'Awas') severity = 'AWAS';
  else if (alert_level === 'Siaga') severity = 'SIAGA';
  else if (alert_level === 'Waspada') severity = 'WASPADA';
  else if (alert_level === 'Normal') severity = 'NORMAL';

  const volcano = VOLCANO_REFERENCE[volcano_id] || { name: 'Unknown Volcano', lat: 0, lon: 0 };

  const attributes: Record<string, unknown> = {
    eruption_count_24h,
    ash_column_height_m,
    ...rest
  };

  return {
    hazard_id: '', // assigned by CanonicalStore.upsert on first insert and kept stable across polls
    source: 'PVMBG',
    source_ref_id: report_id,
    hazard_type: 'VOLCANIC',
    severity,
    area_name: volcano.name,
    latitude: volcano.lat,
    longitude: volcano.lon,
    occurred_at: reported_at,
    ingested_at: new Date().toISOString(),
    attributes
  };
}
