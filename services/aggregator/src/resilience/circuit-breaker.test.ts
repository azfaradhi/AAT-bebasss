import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

describe('CircuitBreaker', () => {
  it('opens after the configured failures and permits a successful probe after cooldown', async () => {
    let now = 0;
    const breaker = new CircuitBreaker(2, 1000, () => now);
    const fail = vi.fn().mockRejectedValue(new Error('PVMBG unavailable'));

    await expect(breaker.execute(fail)).rejects.toThrow('PVMBG unavailable');
    await expect(breaker.execute(fail)).rejects.toThrow('PVMBG unavailable');
    await expect(breaker.execute(fail)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fail).toHaveBeenCalledTimes(2);

    now = 1000;
    await expect(breaker.execute(async () => 'recovered')).resolves.toBe('recovered');
  });

  it('allows only one half-open probe at a time', async () => {
    let now = 0;
    const breaker = new CircuitBreaker(1, 1000, () => now);
    await expect(breaker.execute(async () => { throw new Error('unavailable'); })).rejects.toThrow('unavailable');
    now = 1000;
    let release!: () => void;
    const probe = breaker.execute(() => new Promise<string>((resolve) => { release = () => resolve('ok'); }));
    await expect(breaker.execute(async () => 'second probe')).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    await expect(probe).resolves.toBe('ok');
  });
});
