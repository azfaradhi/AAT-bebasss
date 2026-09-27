import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp, SERVICE_NAME } from './app';

const app = buildApp(pino({ level: 'silent' }));

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
});
