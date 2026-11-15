import type { SeismicEvent } from '../../../../shared-types/src/seismic';
import { SchemaIncompatibleError } from './volcanic-schema';

const REQUIRED: Array<[keyof SeismicEvent, 'string' | 'number']> = [
  ['event_id', 'string'], ['occurred_at', 'string'], ['magnitude', 'number'],
  ['epicenter_lat', 'number'], ['epicenter_lon', 'number'],
];

export function checkSeismicEvent(raw: unknown): SeismicEvent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SchemaIncompatibleError('SCHEMA_INCOMPATIBLE', 'record is not an object');
  }
  const record = raw as Record<string, unknown>;
  for (const [field, type] of REQUIRED) {
    const value = record[field];
    if (value === undefined || value === null) throw new SchemaIncompatibleError('SCHEMA_INCOMPATIBLE', `required field missing: ${field}`);
    if (typeof value !== type || (type === 'number' && !Number.isFinite(value))) {
      throw new SchemaIncompatibleError('SCHEMA_INCOMPATIBLE', `field ${field} expected ${type}, got ${typeof value}`);
    }
  }
  if (Number.isNaN(new Date(record.occurred_at as string).getTime())) {
    throw new SchemaIncompatibleError('SCHEMA_INCOMPATIBLE', 'field occurred_at is not a timestamp');
  }
  return record as unknown as SeismicEvent;
}
