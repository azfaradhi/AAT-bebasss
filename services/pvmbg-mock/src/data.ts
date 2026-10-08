import { randomUUID } from 'node:crypto';
import type { VolcanicReport } from '../../../shared-types/src/volcanic';

const ONE_HOUR = 3_600_000;
const SEED_COUNT = 25;

// Keys of the Aggregator's static volcano reference table (services/aggregator/src/mapping/volcano-reference.ts).
export const VOLCANO_IDS = ['v-merapi', 'v-semeru', 'v-kelud', 'v-sinabung', 'v-agung'] as const;

export interface PvmbgState {
  reports: VolcanicReport[];
  // Toggled by POST /admin/schema-version. Only records generated after the toggle carry confidence_level.
  schemaConfidenceLevelEnabled: boolean;
  outageActive: boolean;
  outageTimeout: NodeJS.Timeout | null;
}

function generateReport(state: PvmbgState, timestamp: Date, random: () => number): VolcanicReport {
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
  return report;
}

export function createPvmbgState(now = Date.now(), random: () => number = Math.random): PvmbgState {
  const state: PvmbgState = {
    reports: [],
    schemaConfidenceLevelEnabled: false,
    outageActive: false,
    outageTimeout: null,
  };
  for (let i = 0; i < SEED_COUNT; i++) {
    const reportedAt = new Date(now - 24 * ONE_HOUR + i * 0.9 * ONE_HOUR);
    state.reports.push(generateReport(state, reportedAt, random));
  }
  return state;
}

// Live report, added every 10 seconds by index.ts.
export function addLiveReport(state: PvmbgState, now = new Date(), random: () => number = Math.random): void {
  state.reports.push(generateReport(state, now, random));
}
