import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../resilience/circuit-breaker';
import { ConcurrencyLimiter } from '../resilience/concurrency-limiter';
import { PvmbgClient } from './pvmbg-client';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => vi.unstubAllGlobals());

describe('PvmbgClient', () => {
  it('uses the bearer credential and converts reports into canonical hazards', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ report_id: 'r-1', volcano_id: 'MERAPI', alert_level: 'Siaga', eruption_count_24h: 2, ash_column_height_m: 1200, reported_at: '2026-10-04T00:00:00.000Z' }],
    })));
    vi.stubGlobal('fetch', fetchMock);
    const client = new PvmbgClient({
      baseUrl: 'http://pvmbg.test', accessToken: 'token', timeoutMs: 1000, logger,
      circuitBreaker: new CircuitBreaker(3, 1000), limiter: new ConcurrencyLimiter(1),
    });

    const hazards = await client.poll();

    expect(fetchMock.mock.calls[0][1].headers).toEqual({ authorization: 'Bearer token' });
    expect(hazards[0]).toMatchObject({ source: 'PVMBG', source_ref_id: 'r-1', hazard_type: 'VOLCANIC', severity: 'SIAGA' });
  });
});
