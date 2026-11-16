import { METRICS } from '../../../shared-types/src/m2/types';

export class SatelliteMetrics {
  frames = 0;
  duplicates = 0;
  gaps = 0;
  parked = 0;
  reconnects = 0;
  committedOffset = -1;
  latestOffset: number | null = null;

  private readonly e2eBuckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
  private readonly e2eCounts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  private e2eSum = 0;
  private e2eCount = 0;

  // Time from a frame arriving at the processor to its effects being stored (P4-K4 latency).
  // Bounded list of raw samples so a test run can report an exact percentile.
  readonly samples: number[] = [];
  private static readonly SAMPLE_CAP = 200_000;

  percentile(q: number): number | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  }

  observeEventToStore(seconds: number): void {
    if (this.samples.length < SatelliteMetrics.SAMPLE_CAP) this.samples.push(seconds);
    this.e2eBuckets.forEach((le, i) => { if (seconds <= le) this.e2eCounts[i]++; });
    this.e2eSum += seconds;
    this.e2eCount++;
  }

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
      `# TYPE ${METRICS.satEventToStore} histogram`,
      ...this.e2eBuckets.map((le, i) => `${METRICS.satEventToStore}_bucket{le="${le}"} ${this.e2eCounts[i]}`),
      `${METRICS.satEventToStore}_bucket{le="+Inf"} ${this.e2eCount}`,
      `${METRICS.satEventToStore}_sum ${this.e2eSum}`,
      `${METRICS.satEventToStore}_count ${this.e2eCount}`,
      ''
    ].join('\n');
  }
}
