import { describe, expect, it, vi } from 'vitest';
import { ConcurrencyLimiter } from './concurrency-limiter';

describe('ConcurrencyLimiter', () => {
  it('does not start more operations than its configured limit', async () => {
    const limiter = new ConcurrencyLimiter(1);
    let releaseFirst!: () => void;
    const first = limiter.run(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    const secondOperation = vi.fn().mockResolvedValue(undefined);
    const second = limiter.run(secondOperation);

    await Promise.resolve();
    expect(secondOperation).not.toHaveBeenCalled();
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondOperation).toHaveBeenCalledOnce();
  });
});
