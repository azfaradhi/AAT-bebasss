import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp, SERVICE_NAME } from './app';
import type { CanonicalStore } from './storage/canonical-store';

const store: CanonicalStore = {
  init: async () => undefined,
  upsert: async (event) => ({ event, created: true }),
  list: async () => ({ data: [], meta: { stale_since: null } }),
  markSourceFresh: async () => undefined,
  markSourceStale: async () => undefined,
  close: async () => undefined,
};
const app = buildApp(pino({ level: 'silent' }), { store, internalServiceKey: 'internal-key' });

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

  it('protects the internal read endpoint with the internal service key', async () => {
    expect((await app.inject({ method: 'GET', url: '/internal/hazard-events' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/internal/hazard-events', headers: { 'x-internal-service-key': 'internal-key' } })).statusCode).toBe(200);
  });

  it('echoes an inbound correlation ID for internal calls', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/internal/hazard-events',
      headers: { 'x-internal-service-key': 'internal-key', 'x-correlation-id': 'trace-123' },
    });
    expect(res.headers['x-correlation-id']).toBe('trace-123');
  });
});
