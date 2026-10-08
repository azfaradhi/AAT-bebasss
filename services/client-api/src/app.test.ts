import { describe, expect, it } from 'vitest';
import { SERVICE_NAME, buildApp } from './app';
import { buildTestApp, signAccessToken } from './test-helpers';

describe('GET /health', () => {
  it('is public: no token required', async () => {
    const res = await buildTestApp().inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: SERVICE_NAME });
  });

  it('unknown route returns ErrorEnvelope 404', async () => {
    const res = await buildTestApp().inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
});

describe('GET /hazard-events (full pipeline: correlationId -> auth -> rbacFilter -> route)', () => {
  it('rejects an unauthenticated request with 401, not the route handler', async () => {
    const res = await buildTestApp().inject({ method: 'GET', url: '/hazard-events' });
    expect(res.statusCode).toBe(401);
  });

  it('scope media, default view: filtered to Ringkasan fields', async () => {
    const token = signAccessToken('media');
    const res = await buildTestApp().inject({ method: 'GET', url: '/hazard-events', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const [event] = res.json().data;
    expect(Object.keys(event).sort()).toEqual(['area_name', 'hazard_id', 'hazard_type', 'ingested_at', 'occurred_at', 'severity', 'source'].sort());
  });

  it('scope media, view=raw: 403 FORBIDDEN_FIELD_ACCESS', async () => {
    const token = signAccessToken('media');
    const res = await buildTestApp().inject({ method: 'GET', url: '/hazard-events?view=raw', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN_FIELD_ACCESS');
  });

  it('scope lapangan, view=raw: full event, including Mentah fields', async () => {
    const token = signAccessToken('lapangan');
    const res = await buildTestApp().inject({ method: 'GET', url: '/hazard-events?view=raw', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const [event] = res.json().data;
    expect(event).toHaveProperty('source_ref_id');
    expect(event).toHaveProperty('attributes');
  });

  it('propagates meta.stale_since unchanged (null when live)', async () => {
    const token = signAccessToken('internal');
    const res = await buildTestApp().inject({ method: 'GET', url: '/hazard-events', headers: { authorization: `Bearer ${token}` } });
    expect(res.json().meta.stale_since).toBeNull();
  });

  it('echoes X-Correlation-ID through the auth rejection path too', async () => {
    const res = await buildTestApp().inject({ method: 'GET', url: '/hazard-events', headers: { 'x-correlation-id': 'req-abc' } });
    expect(res.headers['x-correlation-id']).toBe('req-abc');
  });

  it('rejects an unknown hazard_type with 400 BAD_REQUEST', async () => {
    const token = signAccessToken('internal');
    const res = await buildTestApp().inject({ method: 'GET', url: '/hazard-events?hazard_type=FIRE', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('rejects a since value that is not an ISO timestamp with 400', async () => {
    const token = signAccessToken('internal');
    const res = await buildTestApp().inject({ method: 'GET', url: '/hazard-events?since=yesterday', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(400);
  });

  it('accepts hazard_type, since, and limit when valid', async () => {
    const token = signAccessToken('internal');
    const res = await buildTestApp().inject({
      method: 'GET',
      url: '/hazard-events?hazard_type=VOLCANIC&since=2026-10-06T00:00:00.000Z&limit=10',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
