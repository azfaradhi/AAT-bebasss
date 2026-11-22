import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextStorage } from '../context';
import { HttpAggregatorClient } from './aggregator-client';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [], meta: { stale_since: null } })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('HttpAggregatorClient', () => {
  it('forwards the request correlation ID and the X-Internal-Key header', async () => {
    const fetchMock = stubFetch();
    const client = new HttpAggregatorClient('http://aggregator.test', 'internal-key', logger, 500);

    await contextStorage.run({ correlationId: 'trace-123' }, () => client.getHazards());

    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      'x-internal-key': 'internal-key',
      'x-correlation-id': 'trace-123',
    });
  });

  it('forwards hazard_type, since, and limit as query parameters', async () => {
    const fetchMock = stubFetch();
    const client = new HttpAggregatorClient('http://aggregator.test', 'internal-key', logger, 500);

    await client.getHazards({ hazardType: 'SEISMIC', since: '2026-10-06T00:00:00.000Z', limit: 50 });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('hazard_type')).toBe('SEISMIC');
    expect(url.searchParams.get('since')).toBe('2026-10-06T00:00:00.000Z');
    expect(url.searchParams.get('limit')).toBe('50');
  });
  describe('micro-cache and stale fallback', () => {
    const body = { data: [{ hazard_id: 'h1' }], meta: { stale_since: null } };
    const make = (t: { v: number }, ttl = 1000, max = 600_000) =>
      new HttpAggregatorClient('http://aggregator.test', 'k', logger, 500, { ttlMs: ttl, staleMaxAgeMs: max, now: () => t.v });

    it('does not call the aggregator again within the TTL', async () => {
      const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body)));
      vi.stubGlobal('fetch', fetchMock);
      const t = { v: 1_000_000 };
      const client = make(t);
      await client.getHazards({ limit: 5 });
      t.v += 500;
      await client.getHazards({ limit: 5 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('serves the previous response with meta.stale_since when the aggregator fails', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(body))).mockRejectedValue(new Error('timeout'));
      vi.stubGlobal('fetch', fetchMock);
      const t = { v: 1_000_000 };
      const client = make(t);
      await client.getHazards({ limit: 5 });
      t.v += 5_000;
      const res = await client.getHazards({ limit: 5 });
      expect(res.data).toEqual(body.data);
      expect(res.meta.stale_since).toBe(new Date(1_000_000).toISOString());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('answers 503 UPSTREAM_UNAVAILABLE when there is no earlier response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
      await expect(make({ v: 1 }).getHazards()).rejects.toMatchObject({ statusCode: 503, code: 'UPSTREAM_UNAVAILABLE' });
    });

    it('does not serve an entry older than the maximum age', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(body))).mockRejectedValue(new Error('timeout'));
      vi.stubGlobal('fetch', fetchMock);
      const t = { v: 1_000_000 };
      const client = make(t, 1000, 10_000);
      await client.getHazards();
      t.v += 20_000;
      await expect(client.getHazards()).rejects.toMatchObject({ statusCode: 503 });
    });
  });
});
