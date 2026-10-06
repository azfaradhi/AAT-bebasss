import { afterEach, describe, expect, it, vi } from 'vitest';
import { BmkgClient } from './bmkg-client';
import { contextStorage } from '../context';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => vi.unstubAllGlobals());

describe('BmkgClient', () => {
  it('fetches seismic events and tsunami warnings concurrently with the BMKG key', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ event_id: 'e-1', magnitude: 6, depth_km: 10, epicenter_lat: -6, epicenter_lon: 106, region_name: 'Test', occurred_at: '2026-10-04T00:00:00.000Z', potential_tsunami: false }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal('fetch', fetchMock);
    const client = new BmkgClient({ baseUrl: 'http://bmkg.test', apiKey: 'key', timeoutMs: 1000, logger });

    const hazards = await contextStorage.run(
      { correlationId: 'poll-trace-123' },
      () => client.poll('2026-10-03T00:00:00.000Z'),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      'x-bmkg-key': 'key',
      'x-correlation-id': 'poll-trace-123',
    });
    expect(hazards[0]).toMatchObject({ source: 'BMKG', source_ref_id: 'e-1', hazard_type: 'SEISMIC' });
  });
});
