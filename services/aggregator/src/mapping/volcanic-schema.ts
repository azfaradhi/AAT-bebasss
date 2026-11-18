import type { VolcanicReport } from '../../../../shared-types/src/volcanic';
import { VOLCANO_REFERENCE } from './volcano-reference';

export type SchemaReason = 'SCHEMA_INCOMPATIBLE' | 'UNKNOWN_ENUM_VALUE';

export class SchemaIncompatibleError extends Error {
  constructor(readonly reason_code: SchemaReason, readonly detail: string) {
    super(`${reason_code}: ${detail}`);
    this.name = 'SchemaIncompatibleError';
  }
}

const ALERT_LEVELS = ['Normal', 'Waspada', 'Siaga', 'Awas'];

function requireType(raw: Record<string, unknown>, field: string, type: 'string' | 'number'): void {
  const value = raw[field];
  if (value === undefined || value === null) throw new SchemaIncompatibleError('SCHEMA_INCOMPATIBLE', `required field missing: ${field}`);
  if (typeof value !== type || (type === 'number' && !Number.isFinite(value))) {
    throw new SchemaIncompatibleError('SCHEMA_INCOMPATIBLE', `field ${field} expected ${type}, got ${typeof value}`);
  }
}

export type MapperVersion = 'v1' | 'v2';

const NUMERIC = /^-?\d+(\.\d+)?$/;

// v1 = the declared policy (rename and type change are parked). v2 additionally understands the two incompatible
// shapes the mock produces: `volcano_code` for `volcano_id`, and numeric strings for the two numeric fields.
export function normalizeVolcanicReport(raw: unknown, version: MapperVersion): unknown {
  if (version === 'v1' || typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const record = { ...(raw as Record<string, unknown>) };
  if (record.volcano_id === undefined && typeof record.volcano_code === 'string') {
    record.volcano_id = record.volcano_code;
    delete record.volcano_code;
  }
  for (const field of ['eruption_count_24h', 'ash_column_height_m']) {
    const value = record[field];
    if (typeof value === 'string' && NUMERIC.test(value.trim())) record[field] = Number(value);
  }
  return record;
}

// Absorbs additive changes (extra fields, nulls on optional fields, int to float); parks the rest.
export function checkVolcanicReport(raw: unknown): VolcanicReport {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SchemaIncompatibleError('SCHEMA_INCOMPATIBLE', 'record is not an object');
  }
  const record = raw as Record<string, unknown>;
  requireType(record, 'report_id', 'string');
  requireType(record, 'volcano_id', 'string');
  requireType(record, 'alert_level', 'string');
  requireType(record, 'eruption_count_24h', 'number');
  requireType(record, 'ash_column_height_m', 'number');
  requireType(record, 'reported_at', 'string');

  if (!ALERT_LEVELS.includes(record.alert_level as string)) {
    throw new SchemaIncompatibleError('UNKNOWN_ENUM_VALUE', `alert_level: ${String(record.alert_level).slice(0, 40)}`);
  }
  if (!(record.volcano_id as string in VOLCANO_REFERENCE)) {
    throw new SchemaIncompatibleError('UNKNOWN_ENUM_VALUE', `volcano_id: ${String(record.volcano_id).slice(0, 40)}`);
  }
  if (Number.isNaN(new Date(record.reported_at as string).getTime())) {
    throw new SchemaIncompatibleError('SCHEMA_INCOMPATIBLE', 'field reported_at is not a timestamp');
  }
  return record as unknown as VolcanicReport;
}
