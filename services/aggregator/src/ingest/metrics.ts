import { METRICS, type Parker } from '../../../../shared-types/src/m2/types';

export type IngestOutcome = 'mapped' | 'parked' | 'retrying' | 'response_rejected';

export class IngestMetrics {
  private readonly events = new Map<string, number>();
  private parked = new Map<string, number>();

  record(source: string, outcome: IngestOutcome): void {
    const key = `${source}|${outcome}`;
    this.events.set(key, (this.events.get(key) ?? 0) + 1);
  }

  async refreshParked(parker: Parker): Promise<void> {
    const next = new Map<string, number>();
    let cursor: string | undefined;
    do {
      const page = await parker.listUnprocessed({ limit: 1000, cursor });
      for (const m of page.items) {
        const key = `${m.status}|${m.reason_code}`;
        next.set(key, (next.get(key) ?? 0) + 1);
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    this.parked = next;
  }

  render(): string {
    const lines = [`# TYPE ${METRICS.ingestEvents} counter`];
    for (const [key, value] of this.events) {
      const [source, outcome] = key.split('|');
      lines.push(`${METRICS.ingestEvents}{source="${source}",outcome="${outcome}"} ${value}`);
    }
    lines.push(`# TYPE ${METRICS.parked} gauge`);
    for (const [key, value] of this.parked) {
      const [status, reason] = key.split('|');
      lines.push(`${METRICS.parked}{status="${status}",reason_code="${reason}"} ${value}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
