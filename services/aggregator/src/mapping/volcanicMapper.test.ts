import { describe, expect, it } from 'vitest';
import { mapVolcanicReportToHazardEvent } from './volcanicMapper';

describe('mapVolcanicReportToHazardEvent', () => {
  it('preserves newly introduced source fields inside attributes without a mapper change', () => {
    const report: import('../../../../shared-types/src/volcanic').VolcanicReport & { future_source_field: string } = {
      report_id: 'report-1',
      volcano_id: 'v-merapi',
      alert_level: 'Siaga',
      eruption_count_24h: 3,
      ash_column_height_m: 1200,
      reported_at: '2026-10-06T00:00:00.000Z',
      confidence_level: 0.91,
      future_source_field: 'retained',
    };
    const event = mapVolcanicReportToHazardEvent(report);

    expect(event).toMatchObject({
      source: 'PVMBG',
      source_ref_id: 'report-1',
      area_name: 'Gunung Merapi',
      attributes: {
        confidence_level: 0.91,
        future_source_field: 'retained',
      },
    });
  });
});
