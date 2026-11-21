import { describe, expect, it } from 'vitest';
import { notifierDeliveriesProvider } from './critical-deliveries-provider';

describe('notifierDeliveriesProvider', () => {
  it('forwards limit and cursor and returns the notifier body unchanged', async () => {
    const seen: string[] = [];
    const body = { items: [{ message_id: 'm', hazard_id: 'h', delivered_at: '2026-11-21T00:00:00.000Z', e2e_seconds: 0.4 }], total: 1, p95_seconds: 0.4, next_cursor: null };
    const p = notifierDeliveriesProvider('http://notifier:8093', 1000, (async (u: URL | string) => { seen.push(String(u)); return new Response(JSON.stringify(body)); }) as typeof fetch);
    expect(await p({ limit: 50, cursor: 'm0' })).toEqual(body);
    expect(seen[0]).toBe('http://notifier:8093/internal/critical-deliveries?limit=50&cursor=m0');
  });

  it('throws when the notifier is unreachable or errors, so the Audit route answers 503', async () => {
    const down = notifierDeliveriesProvider('http://notifier:8093', 1000, (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch);
    await expect(down({ limit: 10 })).rejects.toThrow();
    const err = notifierDeliveriesProvider('http://notifier:8093', 1000, (async () => new Response('x', { status: 500 })) as typeof fetch);
    await expect(err({ limit: 10 })).rejects.toThrow(/500/);
  });
});
