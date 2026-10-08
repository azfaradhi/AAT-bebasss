import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { buildApp, SERVICE_NAME } from './app';
import type { CanonicalStore } from './storage/canonical-store';

const list = vi.fn(async () => ({ data: [], meta: { stale_since: null } }));
const store: CanonicalStore = {
  init: async () => undefined,
  upsert: async (event) => ({ event, created: true }),
  list,
  getLastSuccessAt: async () => null,
  markSourceFresh: async () => undefined,
  markSourceStale: async () => undefined,
  close: async () => undefined,
};
const app = buildApp(pino({ level: 'silent' }), { store, internalServiceKey: 'internal-key' });
const authorized = { 'x-internal-key': 'internal-key' };

describe('aggregator HTTP skeleton', () => {
  it('exposes the standard health endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: SERVICE_NAME });
  });

  it('returns the standard error envelope for an unknown route', async () => {
    const res = await app.inject({ method: 'GET', url: '/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  it('protects the internal read endpoint with the X-Internal-Key header', async () => {
    expect((await app.inject({ method: 'GET', url: '/internal/hazard-events' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/internal/hazard-events', headers: authorized })).statusCode).toBe(200);
  });

  it('echoes an inbound correlation ID for internal calls', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/internal/hazard-events',
      headers: { ...authorized, 'x-correlation-id': 'trace-123' },
    });
    expect(res.headers['x-correlation-id']).toBe('trace-123');
  });
});

describe('GET /internal/hazard-events query validation', () => {
  it('passes hazard_type, since, and limit through to the store', async () => {
    list.mockClear();
    await app.inject({
      method: 'GET',
      url: '/internal/hazard-events?hazard_type=VOLCANIC&since=2026-10-06T00:00:00.000Z&limit=20',
      headers: authorized,
    });
    expect(list).toHaveBeenCalledWith({ hazardType: 'VOLCANIC', since: '2026-10-06T00:00:00.000Z', limit: 20 });
  });

  it('rejects an unknown hazard_type with 400 and the error envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/internal/hazard-events?hazard_type=FIRE', headers: authorized });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('rejects a since value that is not an ISO timestamp', async () => {
    const res = await app.inject({ method: 'GET', url: '/internal/hazard-events?since=not-a-date', headers: authorized });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-positive limit', async () => {
    const res = await app.inject({ method: 'GET', url: '/internal/hazard-events?limit=0', headers: authorized });
    expect(res.statusCode).toBe(400);
  });
});
