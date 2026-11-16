import { METRICS } from '../../../shared-types/src/m2/types';

export class SatelliteMetrics {
  frames = 0;
  duplicates = 0;
  gaps = 0;
  parked = 0;
  reconnects = 0;
  committedOffset = -1;
  latestOffset: number | null = null;

  lag(): number | null {
    return this.latestOffset === null ? null : Math.max(0, this.latestOffset - this.committedOffset);
  }

  render(): string {
    const lag = this.lag();
    return [
      `# TYPE ${METRICS.ingestEvents} counter`,
      `${METRICS.ingestEvents}{source="SATELIT",outcome="accepted"} ${this.frames}`,
      `${METRICS.ingestEvents}{source="SATELIT",outcome="duplicate"} ${this.duplicates}`,
      `${METRICS.ingestEvents}{source="SATELIT",outcome="parked"} ${this.parked}`,
      `# TYPE bnpb_sat_gaps_total counter`,
      `bnpb_sat_gaps_total ${this.gaps}`,
      `# TYPE bnpb_sat_reconnects_total counter`,
      `bnpb_sat_reconnects_total ${this.reconnects}`,
      `# TYPE ${METRICS.satOffsetLag} gauge`,
      `${METRICS.satOffsetLag} ${lag ?? 0}`,
      '',
    ].join('\n');
  }
}
