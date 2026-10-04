export class CircuitOpenError extends Error {
  constructor() {
    super('Circuit breaker is open');
    this.name = 'CircuitOpenError';
  }
}

type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.allowRequest();
    try {
      const value = await operation();
      this.reset();
      return value;
    } catch (err) {
      this.recordFailure();
      throw err;
    } finally {
      this.probeInFlight = false;
    }
  }

  private allowRequest(): void {
    if (this.state === 'closed') return;
    if (this.state === 'half-open') throw new CircuitOpenError();
    if (this.now() - this.openedAt < this.cooldownMs) throw new CircuitOpenError();
    this.state = 'half-open';
    this.probeInFlight = true;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === 'half-open' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  private reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }
}
