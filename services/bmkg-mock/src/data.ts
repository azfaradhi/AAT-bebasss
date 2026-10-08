import { randomUUID } from 'node:crypto';
import type { SeismicEvent, TsunamiWarning } from '../../../shared-types/src/seismic';

const ONE_HOUR = 3_600_000;
const SEED_COUNT = 25;

export interface BmkgState {
  seismicEvents: SeismicEvent[];
  tsunamiWarnings: TsunamiWarning[];
}

interface GeneratedRecord {
  event: SeismicEvent;
  warning?: TsunamiWarning;
}

function generateRecord(
  occurredAt: string,
  regionName: string,
  zones: [string, string],
  random: () => number,
): GeneratedRecord {
  const event_id = randomUUID();
  const isTsunami = random() > 0.8;
  const magnitude = 4.0 + random() * 4.0; // 4.0 to 8.0

  const event: SeismicEvent = {
    event_id,
    magnitude: parseFloat(magnitude.toFixed(1)),
    depth_km: Math.floor(10 + random() * 100),
    epicenter_lat: parseFloat((-10 + random() * 15).toFixed(4)),
    epicenter_lon: parseFloat((95 + random() * 45).toFixed(4)),
    region_name: regionName,
    occurred_at: occurredAt,
    potential_tsunami: isTsunami,
  };

  if (!isTsunami) return { event };

  let threat_level: TsunamiWarning['threat_level'] = 'Waspada';
  if (magnitude >= 7.0) threat_level = 'Awas';
  else if (magnitude >= 6.0) threat_level = 'Siaga';

  const warning: TsunamiWarning = {
    warning_id: randomUUID(),
    related_event_id: event_id,
    threat_level,
    affected_zones: zones,
    estimated_arrival: new Date(new Date(occurredAt).getTime() + 2 * ONE_HOUR).toISOString(),
  };
  return { event, warning };
}

function push(state: BmkgState, record: GeneratedRecord): void {
  state.seismicEvents.push(record.event);
  if (record.warning) state.tsunamiWarnings.push(record.warning);
}

// Seed: SEED_COUNT events spread over the last 24 hours (contract §4.1).
export function createBmkgState(now = Date.now(), random: () => number = Math.random): BmkgState {
  const state: BmkgState = { seismicEvents: [], tsunamiWarnings: [] };
  for (let i = 0; i < SEED_COUNT; i++) {
    const occurredAt = new Date(now - 24 * ONE_HOUR + i * 0.9 * ONE_HOUR).toISOString();
    push(state, generateRecord(occurredAt, `Region ${i}`, [`Zone A-${i}`, `Zone B-${i}`], random));
  }
  return state;
}

// Live record, added every 10 seconds by index.ts (spec: at least 1 new event per 10 seconds per instance).
export function addLiveRecord(state: BmkgState, now = new Date(), random: () => number = Math.random): void {
  const region = `Live Region ${Math.floor(random() * 100)}`;
  push(state, generateRecord(now.toISOString(), region, ['Live Zone A', 'Live Zone B'], random));
}
