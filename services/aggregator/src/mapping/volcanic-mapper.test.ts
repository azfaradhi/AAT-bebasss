import { describe, expect, it } from 'vitest';
import { mapVolcanicReportToHazardEvent } from './volcanic-mapper';

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

describe('schema-change policy (additive + widening)', () => {
  const base = {
    report_id: 'r-1', volcano_id: 'v-merapi', alert_level: 'Siaga', eruption_count_24h: 3,
    ash_column_height_m: 1200, reported_at: '2026-10-06T00:00:00.000Z',
  };
  const map = (over: Record<string, unknown>, drop: string[] = []) => {
    const record: Record<string, unknown> = { ...base, ...over };
    for (const key of drop) delete record[key];
    return () => mapVolcanicReportToHazardEvent(record as never);
  };

  it.each([
    ['additive optional field', { observer_note: 'x' }],
    ['null for an optional field', { confidence_level: null }],
    ['int to float widening', { ash_column_height_m: 1200.5 }],
  ])('absorbs %s', (_name, over) => {
    const event = map(over)();
    expect(event.attributes.ash_column_height_m).toBeDefined();
    expect(Object.values(event.attributes)).not.toContain(null);
  });

  it('keeps an additive field in attributes and ignores key order', () => {
    const event = mapVolcanicReportToHazardEvent({ reported_at: base.reported_at, observer_note: 'x', ...base } as never);
    expect(event.attributes.observer_note).toBe('x');
  });

  it.each([
    ['rename', {}, ['volcano_id'], 'SCHEMA_INCOMPATIBLE'],
    ['type change', { eruption_count_24h: '3' }, [], 'SCHEMA_INCOMPATIBLE'],
    ['required field dropped', {}, ['ash_column_height_m'], 'SCHEMA_INCOMPATIBLE'],
    ['unknown alert_level', { alert_level: 'Siaga-II' }, [], 'UNKNOWN_ENUM_VALUE'],
    ['unknown volcano_id', { volcano_id: 'v-unknown' }, [], 'UNKNOWN_ENUM_VALUE'],
  ])('parks %s as %s', (_name, over, drop, code) => {
    expect(map(over, drop)).toThrowError(expect.objectContaining({ name: 'SchemaIncompatibleError', reason_code: code }));
  });
});
