import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp, SERVICE_NAME } from './app';

const app = buildApp(pino({ level: 'silent' }), () => true);

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

  it('reports degraded (still 200) while not attached to the broker', async () => {
    const detached = buildApp(pino({ level: 'silent' }), () => false);
    const res = await detached.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('degraded');
  });
});
