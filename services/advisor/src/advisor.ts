import { AnomalyDetector } from './detector';
import { LABEL, templateSummary, validateSummary, type FireFacts, type Flag } from './facts';
import { LlmClient, LlmError } from './llm';
import { BoundedQueue, CircuitBreaker, TokenBucket } from './resilience';
import type { Advisory, EventSource, StorageAdvisoryStore } from './store';

export type Outcome = 'flagged' | 'llm' | 'template' | 'rejected' | 'dropped' | 'timeout' | 'llm_error' | 'breaker_open' | 'rate_limited' | 'source_error' | 'store_error';

export class AdvisorMetrics {
  private readonly counts = new Map<Outcome, number>();
  breaker: string = 'closed';
  queueSize = 0;
  inc(o: Outcome): void { this.counts.set(o, (this.counts.get(o) ?? 0) + 1); }
  get(o: Outcome): number { return this.counts.get(o) ?? 0; }
  render(): string {
    const state = { closed: 0, half_open: 1, open: 2 }[this.breaker as 'closed'] ?? 0;
    return [
      '# TYPE bnpb_advisory_total counter',
      ...[...this.counts.entries()].map(([o, n]) => `bnpb_advisory_total{outcome="${o}"} ${n}`),
      '# TYPE bnpb_advisory_breaker_state gauge', `bnpb_advisory_breaker_state ${state}`,
      '# TYPE bnpb_advisory_queue_size gauge', `bnpb_advisory_queue_size ${this.queueSize}`, '',
    ].join('\n');
  }
}

export interface AdvisorDeps {
  source: EventSource;
  store: StorageAdvisoryStore;
  detector: AnomalyDetector;
  llm: LlmClient | null; // null: no key, template-only mode
  model: string | null;
  breaker: CircuitBreaker;
  bucket: TokenBucket;
  queueMax: number;
  tickTimeoutMs?: number;
  maxFlagsPerTick?: number;
  clock?: () => number;
  logger?: { warn(o: object, m?: string): void };
}

interface Job { facts: FireFacts; flag: Flag }

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

// Runs beside the alert path: reads published events, flags unusual fires, writes advisory records. Every failure is
// absorbed here and counted; nothing it does can reach a HazardEvent.
export class Advisor {
  readonly metrics = new AdvisorMetrics();
  private readonly queue: BoundedQueue<Job>;
  private readonly llmDone = new Map<string, number>(); // fire id -> detection count already summarized by the LLM
  private readonly clock: () => number;

  constructor(private readonly d: AdvisorDeps) {
    this.clock = d.clock ?? Date.now;
    this.queue = new BoundedQueue<Job>(d.queueMax, (job) => this.summarize(job), () => this.metrics.inc('dropped'));
  }

  async idle(): Promise<void> { await this.queue.idle(); }

  async tick(): Promise<Flag[]> {
    let fires: FireFacts[];
    try { fires = await withTimeout(this.d.source.fires(), this.d.tickTimeoutMs ?? 10_000); } catch (err) {
      this.metrics.inc('source_error');
      this.d.logger?.warn({ err: String(err) }, 'advisor could not read events');
      return [];
    }
    const flags = this.d.detector.observe(this.clock(), fires).slice(0, this.d.maxFlagsPerTick ?? 50);
    const byId = new Map(fires.map((f) => [f.id, f]));
    for (const flag of flags) {
      const facts = byId.get(flag.id)!;
      this.metrics.inc('flagged');
      if (this.llmDone.get(flag.id) !== facts.count) await this.write(facts, flag, templateSummary(facts, flag), 'template');
      if (this.d.llm && this.llmDone.get(flag.id) !== facts.count) this.queue.push({ facts, flag });
    }
    this.metrics.queueSize = this.queue.size;
    return flags;
  }

  private async write(f: FireFacts, flag: Flag, summary: string, source: 'llm' | 'template'): Promise<void> {
    const rec: Advisory = {
      hazard_id: f.id, based_on_count: f.count, flagged: true, score: Math.round(flag.score * 100) / 100, reasons: flag.reasons,
      summary, summary_source: source, model: source === 'llm' ? this.d.model : null, label: LABEL, generated_at: new Date(this.clock()).toISOString(),
    };
    try { await this.d.store.put(rec); this.metrics.inc(source === 'llm' ? 'llm' : 'template'); } catch (err) {
      this.metrics.inc('store_error');
      this.d.logger?.warn({ err: String(err) }, 'advisory not stored');
    }
  }

  private async summarize({ facts, flag }: Job): Promise<void> {
    const { llm, breaker, bucket } = this.d;
    this.metrics.breaker = breaker.state();
    if (!llm) return;
    if (!breaker.allow()) { this.metrics.inc('breaker_open'); return; } // the template record already stands
    if (!bucket.take()) { this.metrics.inc('rate_limited'); return; }
    try {
      const verdict = validateSummary(await llm.summarize(facts, flag), facts, flag);
      if (!verdict.ok) {
        breaker.failure();
        this.metrics.inc('rejected');
        this.d.logger?.warn({ why: verdict.why, fire: facts.id }, 'LLM summary rejected');
      } else {
        breaker.success();
        this.llmDone.set(flag.id, facts.count);
        await this.write(facts, flag, verdict.text, 'llm');
      }
    } catch (err) {
      breaker.failure();
      this.metrics.inc(err instanceof LlmError && err.kind === 'timeout' ? 'timeout' : 'llm_error');
    }
    this.metrics.breaker = breaker.state();
  }
}
