import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextStorage } from '../context';
import { HttpAggregatorClient } from './aggregator-client';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => vi.unstubAllGlobals());

describe('HttpAggregatorClient', () => {
  it('forwards the request correlation ID to the Aggregator', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [], meta: { stale_since: null } })));
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpAggregatorClient('http://aggregator.test', 'internal-key', logger, 500);

    await contextStorage.run({ correlationId: 'trace-123' }, () => client.getHazards());

    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      'x-internal-service-key': 'internal-key',
      'x-correlation-id': 'trace-123',
    });
  });
});
