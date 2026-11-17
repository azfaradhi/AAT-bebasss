/**
 * Bounded retry with exponential backoff and full jitter (P5-K3, MB3-T09).
 * Never retries BreakerOpenError or BulkheadFullError so fast-fail semantics are preserved.
 */
import {
  BreakerOpenError,
  BulkheadFullError,
  type RetryOptions,
} from '../../../../shared-types/src/m2/types';

export function computeFullJitterDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  rng: () => number = Math.random,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(rng() * ceiling);
}

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  rng: () => number = Math.random,
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (err instanceof BreakerOpenError || err instanceof BulkheadFullError) {
        throw err;
      }
      if (opts.isRetryable && !opts.isRetryable(err)) {
        throw err;
      }
      if (attempt >= maxAttempts) {
        break;
      }
      const delayMs = computeFullJitterDelayMs(attempt, opts.baseMs, opts.maxMs, rng);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}
