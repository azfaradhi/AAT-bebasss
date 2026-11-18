export type BreakerState = 'closed' | 'half_open' | 'open';

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(private readonly threshold: number, private readonly cooldownMs: number, private readonly now: () => number = Date.now) {}

  state(): BreakerState {
    if (this.failures < this.threshold) return 'closed';
    return this.now() - this.openedAt >= this.cooldownMs ? 'half_open' : 'open';
  }

  // closed: yes; open: no; half-open: exactly one probe at a time
  allow(): boolean {
    const s = this.state();
    if (s === 'closed') return true;
    if (s === 'half_open' && !this.probing) { this.probing = true; return true; }
    return false;
  }

  success(): void { this.failures = 0; this.probing = false; }
  failure(): void {
    this.failures++;
    this.probing = false;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }
}

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(private readonly perMinute: number, private readonly now: () => number = Date.now) {
    this.tokens = perMinute;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((t - this.last) / 60_000) * this.perMinute);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// One job at a time, bounded; when full the oldest waiting job is dropped (and reported) so a flood cannot grow memory.
export class BoundedQueue<T> {
  private items: T[] = [];
  private running = false;
  dropped = 0;

  constructor(private readonly max: number, private readonly handler: (job: T) => Promise<void>, private readonly onDrop: (job: T) => void = () => undefined) {}

  get size(): number { return this.items.length; }

  push(job: T): void {
    if (this.items.length >= this.max) { this.onDrop(this.items.shift()!); this.dropped++; }
    this.items.push(job);
    void this.run();
  }

  async idle(): Promise<void> { while (this.running || this.items.length > 0) await new Promise((r) => setTimeout(r, 5)); }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length > 0) {
        const job = this.items.shift()!;
        try { await this.handler(job); } catch { /* the handler records its own outcome */ }
      }
    } finally { this.running = false; }
  }
}
