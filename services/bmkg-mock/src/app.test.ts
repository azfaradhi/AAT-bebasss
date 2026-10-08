import { describe, expect, it } from 'vitest';
import { buildApp, SERVICE_NAME } from './app';
import { createBmkgState } from './data';

const KEY = 'bmkg-test-key';
const config = { BMKG_API_KEY: KEY, BMKG_DELAY_MIN_MS: 0, BMKG_DELAY_MAX_MS: 0 };
const app = buildApp({ config, state: createBmkgState(), logger: false });

describe('GET /health', () => {
  it('is public and reports the service name', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: SERVICE_NAME });
  });
});

describe('authentication', () => {
  it('rejects a missing X-BMKG-Key with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/seismic-events' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a wrong X-BMKG-Key with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/seismic-events', headers: { 'x-bmkg-key': 'wrong' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a PVMBG-style Bearer token with 403, even alongside a valid key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/seismic-events',
      headers: { 'x-bmkg-key': KEY, authorization: 'Bearer some.pvmbg.token' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('accepts the correct key', async () => {
    const res = await app.inject({ method: 'GET', url: '/seismic-events', headers: { 'x-bmkg-key': KEY } });
    expect(res.statusCode).toBe(200);
  });
});

describe('data endpoints', () => {
  const headers = { 'x-bmkg-key': KEY };

  it('seeds at least 20 seismic events', async () => {
    const res = await app.inject({ method: 'GET', url: '/seismic-events', headers });
    expect(res.json().data.length).toBeGreaterThanOrEqual(20);
  });

  it('filters seismic events by since', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await app.inject({ method: 'GET', url: `/seismic-events?since=${encodeURIComponent(future)}`, headers });
    expect(res.json().data).toEqual([]);
  });

  it('returns tsunami warnings only for events flagged potential_tsunami', async () => {
    const seismic = (await app.inject({ method: 'GET', url: '/seismic-events', headers })).json().data;
    const warnings = (await app.inject({ method: 'GET', url: '/tsunami-warnings', headers })).json().data;
    const flagged = seismic.filter((e: { potential_tsunami: boolean }) => e.potential_tsunami).map((e: { event_id: string }) => e.event_id);
    expect(warnings.map((w: { related_event_id: string }) => w.related_event_id).sort()).toEqual([...flagged].sort());
  });
});

describe('error envelope', () => {
  it('returns ErrorEnvelope for an unknown route', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope', headers: { 'x-bmkg-key': KEY } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
