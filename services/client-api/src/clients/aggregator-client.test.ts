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
});
