import { describe, it, expect, beforeEach } from 'vitest';
import {
  BreakerOpenError,
  Bulkhead,
  BulkheadFullError,
  CircuitBreaker,
  retryWithBackoff,
} from './index';
import { renderPrometheusMetrics, resetMetricsForTest } from './obs';

describe('M2 Resilience Primitives (MB3-T09, P5-K3, P5-K4, P5-K5)', () => {
  beforeEach(() => {
    resetMetricsForTest();
  });

  it('CircuitBreaker transitions closed -> open -> half_open -> closed and updates bnpb_breaker_state gauge', async () => {
    let clock = 1000;
    const breaker = new CircuitBreaker({
      target: 'sensor-pantai',
      failureThreshold: 3,
      cooldownMs: 5000,
      timeoutMs: 1000,
      jitterRatio: 0,
      now: () => clock,
    });

    expect(breaker.state()).toBe('closed');
    expect(renderPrometheusMetrics()).toContain('bnpb_breaker_state{target="sensor-pantai"} 0');

    // Trip after 3 consecutive failures
    for (let i = 0; i < 3; i++) {
      await expect(
        breaker.exec(async () => {
          throw new Error('sensor timeout');
        }),
      ).rejects.toThrow('sensor timeout');
    }

    expect(breaker.state()).toBe('open');
    expect(renderPrometheusMetrics()).toContain('bnpb_breaker_state{target="sensor-pantai"} 2');

    // While open, fails fast without invoking fn
    let invoked = false;
    await expect(
      breaker.exec(async () => {
        invoked = true;
        return 'ok';
      }),
    ).rejects.toBeInstanceOf(BreakerOpenError);
    expect(invoked).toBe(false);

    // Advance past cooldown -> half_open probe succeeds -> closed
    clock += 5001;
    expect(breaker.state()).toBe('half_open');

    const res = await breaker.exec(async () => 'recovered');
    expect(res).toBe('recovered');
    expect(breaker.state()).toBe('closed');
    expect(renderPrometheusMetrics()).toContain('bnpb_breaker_state{target="sensor-pantai"} 0');
  });

  it('Bulkhead enforces maxConcurrent + maxQueue and throws BulkheadFullError when saturated', async () => {
    const bulkhead = new Bulkhead('sensor-pantai', 2, 1);
    const resolvers: Array<() => void> = [];

    const makeTask = () =>
      bulkhead.exec(
        () =>
          new Promise<string>((resolve) => {
            resolvers.push(() => resolve('done'));
          }),
      );

    // 2 active + 1 queued
    const p1 = makeTask();
    const p2 = makeTask();
    const p3 = makeTask();
    expect(bulkhead.inFlight()).toBe(2);
    expect(bulkhead.queued()).toBe(1);

    // 4th call exceeds maxQueue=1 -> throws BulkheadFullError immediately
    await expect(makeTask()).rejects.toBeInstanceOf(BulkheadFullError);

    // Complete all 3 tasks
    while (resolvers.length > 0) {
      resolvers.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all([p1, p2, p3]);
    expect(bulkhead.inFlight()).toBe(0);
    expect(bulkhead.queued()).toBe(0);
  });

  it('retryWithBackoff uses bounded exponential full jitter and never retries BreakerOpenError', async () => {
    const delays: number[] = [];
    let attempts = 0;

    const val = await retryWithBackoff(
      async (attempt) => {
        attempts = attempt;
        if (attempt < 3) throw new Error('transient');
        return 'success';
      },
      { maxAttempts: 4, baseMs: 100, maxMs: 1000, jitter: 'full' },
      async (ms) => {
        delays.push(ms);
      },
      () => 0.5,
    );

    expect(val).toBe('success');
    expect(attempts).toBe(3);
    expect(delays).toEqual([50, 100]); // 0.5 * 100, 0.5 * 200

    // Never retries BreakerOpenError
    let breakerAttempts = 0;
    await expect(
      retryWithBackoff(
        async () => {
          breakerAttempts++;
          throw new BreakerOpenError('sensor-pantai');
        },
        { maxAttempts: 5, baseMs: 100, maxMs: 1000, jitter: 'full' },
      ),
    ).rejects.toBeInstanceOf(BreakerOpenError);
    expect(breakerAttempts).toBe(1);
  });
});
