import {
  BulkheadFullError,
  type Bulkhead as IBulkhead,
} from '../../../../shared-types/src/m2/types';

export { BulkheadFullError };

export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) throw new Error('maxConcurrent must be at least 1');
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

/**
 * Contract-compliant Bulkhead with bounded concurrency and bounded queue (P5-K3, MB3-T09).
 * Throws BulkheadFullError immediately when active >= maxConcurrent AND waiting.length >= maxQueue.
 */
export class Bulkhead implements IBulkhead {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    public readonly target: string,
    private readonly maxConcurrent: number,
    private readonly maxQueue = 0,
  ) {
    if (maxConcurrent < 1) throw new Error('maxConcurrent must be at least 1');
    if (maxQueue < 0) throw new Error('maxQueue must be >= 0');
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  inFlight(): number {
    return this.active;
  }

  queued(): number {
    return this.waiting.length;
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxQueue) {
      return Promise.reject(new BulkheadFullError(this.target));
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}
