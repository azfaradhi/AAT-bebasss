import {
  BreakerOpenError,
  type BreakerState,
  type CircuitBreaker as ICircuitBreaker,
} from '../../../../shared-types/src/m2/types';
import { METRICS, setGauge } from './obs';

export { BreakerOpenError };

export class CircuitOpenError extends BreakerOpenError {
  constructor(target = 'default') {
    super(target);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  target?: string;
  failureThreshold: number;
  cooldownMs: number;
  timeoutMs?: number;
  /** Cooldown is randomised by +/- this ratio so replicas do not probe a sick target in lockstep. */
  jitterRatio?: number;
  now?: () => number;
  random?: () => number;
}

export class CircuitBreaker implements ICircuitBreaker {
  public readonly target: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private currentCooldownMs: number;

  private currentState: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    thresholdOrOpts: number | CircuitBreakerOptions,
    cooldownMs = 10000,
    now: () => number = Date.now,
    target = 'default',
  ) {
    if (typeof thresholdOrOpts === 'number') {
      this.failureThreshold = thresholdOrOpts;
      this.cooldownMs = cooldownMs;
      this.now = now;
      this.target = target;
      this.timeoutMs = 5000;
      this.jitterRatio = 0;
      this.random = Math.random;
    } else {
      this.failureThreshold = thresholdOrOpts.failureThreshold;
      this.cooldownMs = thresholdOrOpts.cooldownMs;
      this.now = thresholdOrOpts.now ?? Date.now;
      this.target = thresholdOrOpts.target ?? 'default';
      this.timeoutMs = thresholdOrOpts.timeoutMs ?? 5000;
      this.jitterRatio = thresholdOrOpts.jitterRatio ?? 0.2;
      this.random = thresholdOrOpts.random ?? Math.random;
    }
    this.currentCooldownMs = this.cooldownMs;
    this.updateMetric();
  }

  state(): BreakerState {
    if (this.currentState === 'open' && this.now() - this.openedAt >= this.currentCooldownMs && !this.probeInFlight) {
      return 'half_open';
    }
    return this.currentState;
  }

  async exec<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.allowRequest();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`Timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
    try {
      const value = await fn(ac.signal);
      this.reset();
      return value;
    } catch (err) {
      this.recordFailure();
      throw err;
    } finally {
      clearTimeout(timer);
      this.probeInFlight = false;
    }
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    return this.exec(() => operation());
  }

  private allowRequest(): void {
    if (this.currentState === 'closed') return;
    if (this.currentState === 'half_open') {
      throw new CircuitOpenError(this.target);
    }
    if (this.now() - this.openedAt < this.currentCooldownMs) {
      throw new CircuitOpenError(this.target);
    }
    this.currentState = 'half_open';
    this.probeInFlight = true;
    this.updateMetric();
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.currentState === 'half_open' || this.consecutiveFailures >= this.failureThreshold) {
      this.currentState = 'open';
      this.openedAt = this.now();
      this.currentCooldownMs = this.cooldownMs * (1 + (this.random() * 2 - 1) * this.jitterRatio);
      this.updateMetric();
    }
  }

  private reset(): void {
    this.currentState = 'closed';
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
    this.updateMetric();
  }

  private updateMetric(): void {
    const val = this.currentState === 'closed' ? 0 : this.currentState === 'half_open' ? 1 : 2;
    setGauge(METRICS.breakerState, { target: this.target }, val);
  }
}
