import { randomUUID } from 'node:crypto';
import type { VolcanicReport } from '../../../shared-types/src/volcanic';

import type { FuzzCase } from './fuzz';

const ONE_HOUR = 3_600_000;
const SEED_COUNT = 25;

export const VOLCANO_IDS = ['v-merapi', 'v-semeru', 'v-kelud', 'v-sinabung', 'v-agung'] as const;

export const SCHEMA_MODES = ['baseline', 'additive', 'rename', 'type_change', 'drop_required'] as const;
export type SchemaMode = (typeof SCHEMA_MODES)[number];

export type StoredReport = Record<string, unknown>;

export interface PvmbgState {
  reports: StoredReport[];
  schemaConfidenceLevelEnabled: boolean;
  schemaMode: SchemaMode;
  fuzzCase: FuzzCase | null;
  outageActive: boolean;
  outageTimeout: NodeJS.Timeout | null;
}

function generateReport(state: PvmbgState, timestamp: Date, random: () => number): StoredReport {
  const isAwas = random() > 0.9;
  const alert_level: VolcanicReport['alert_level'] = isAwas
    ? 'Awas'
    : random() > 0.7 ? 'Siaga' : random() > 0.5 ? 'Waspada' : 'Normal';

  const report: VolcanicReport = {
    report_id: randomUUID(),
    volcano_id: VOLCANO_IDS[Math.floor(random() * VOLCANO_IDS.length)],
    alert_level,
    eruption_count_24h: Math.floor(random() * 50),
    ash_column_height_m: isAwas ? Math.floor(1000 + random() * 4000) : Math.floor(random() * 500),
    reported_at: timestamp.toISOString(),
  };

  if (state.schemaConfidenceLevelEnabled) {
    report.confidence_level = parseFloat(random().toFixed(2));
  }
  return applySchemaMode(state.schemaMode, report, random);
}

// Only newly generated records change; stored ones keep the shape they were created with.
function applySchemaMode(mode: SchemaMode, base: VolcanicReport, random: () => number): StoredReport {
  const report: StoredReport = { ...base };
  switch (mode) {
    case 'additive':
      report.observer_note = 'auto-generated';
      report.confidence_level = random() > 0.8 ? null : parseFloat(random().toFixed(2));
      report.ash_column_height_m = base.ash_column_height_m + 0.5;
      break;
    case 'rename':
      report.volcano_code = report.volcano_id;
      delete report.volcano_id;
      break;
    case 'type_change':
      report.eruption_count_24h = String(base.eruption_count_24h);
      break;
    case 'drop_required':
      delete report.ash_column_height_m;
      break;
    case 'baseline':
      break;
  }
  return report;
}

export function createPvmbgState(now = Date.now(), random: () => number = Math.random): PvmbgState {
  const state: PvmbgState = {
    reports: [],
    schemaConfidenceLevelEnabled: false,
    schemaMode: 'baseline',
    fuzzCase: null,
    outageActive: false,
    outageTimeout: null,
  };
  for (let i = 0; i < SEED_COUNT; i++) {
    const reportedAt = new Date(now - 24 * ONE_HOUR + i * 0.9 * ONE_HOUR);
    state.reports.push(generateReport(state, reportedAt, random));
  }
  return state;
}

export function addLiveReport(state: PvmbgState, now = new Date(), random: () => number = Math.random): void {
  state.reports.push(generateReport(state, now, random));
}
