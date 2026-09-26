import { describe, expect, it } from 'vitest';
import { SERVICE_NAME } from './app';
import { buildTestApp } from './test-helpers';

const { app } = buildTestApp();

describe('GET /health', () => {
  it('returns HealthResponse', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe(SERVICE_NAME);
    expect(typeof body.timestamp).toBe('string');
  });

  it('unknown route returns ErrorEnvelope 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  it('echoes an inbound X-Correlation-ID and generates one otherwise', async () => {
    const given = await app.inject({ method: 'GET', url: '/health', headers: { 'x-correlation-id': 'abc-123' } });
    expect(given.headers['x-correlation-id']).toBe('abc-123');
    const generated = await app.inject({ method: 'GET', url: '/health' });
    expect(generated.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
