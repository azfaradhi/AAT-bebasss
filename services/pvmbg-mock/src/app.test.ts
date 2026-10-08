import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { buildApp, SERVICE_NAME } from './app';
import { addLiveReport, createPvmbgState, type PvmbgState } from './data';

const SECRET = 'pvmbg-test-secret';
const config = { PVMBG_JWT_SECRET: SECRET, PVMBG_DELAY_MIN_MS: 0, PVMBG_DELAY_MAX_MS: 0 };
const validToken = jwt.sign({ sub: 'aggregator' }, SECRET, { audience: 'pvmbg', expiresIn: 3600 });
const auth = { authorization: `Bearer ${validToken}` };

function freshApp(): { state: PvmbgState; app: ReturnType<typeof buildApp> } {
  const state = createPvmbgState();
  return { state, app: buildApp({ config, state, logger: false }) };
}

describe('GET /health', () => {
  it('reports ok and the service name', async () => {
    const { app } = freshApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({ status: 'ok', service: SERVICE_NAME });
  });
});

describe('authentication', () => {
  it('rejects a missing token with 401', async () => {
    const { app } = freshApp();
    const res = await app.inject({ method: 'GET', url: '/volcanic-reports' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token signed with another secret with 401', async () => {
    const { app } = freshApp();
    const forged = jwt.sign({ sub: 'x' }, 'other-secret', { audience: 'pvmbg' });
    const res = await app.inject({ method: 'GET', url: '/volcanic-reports', headers: { authorization: `Bearer ${forged}` } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a BMKG key with 403', async () => {
    const { app } = freshApp();
    const res = await app.inject({ method: 'GET', url: '/volcanic-reports', headers: { 'x-bmkg-key': 'anything' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('accepts a valid PVMBG token', async () => {
    const { app } = freshApp();
    const res = await app.inject({ method: 'GET', url: '/volcanic-reports', headers: auth });
    expect(res.statusCode).toBe(200);
  });
});

describe('volcanic reports', () => {
  it('seeds at least 20 reports that reference known volcano IDs', async () => {
    const { app } = freshApp();
    const data = (await app.inject({ method: 'GET', url: '/volcanic-reports', headers: auth })).json().data;
    expect(data.length).toBeGreaterThanOrEqual(20);
    for (const r of data) expect(['v-merapi', 'v-semeru', 'v-kelud', 'v-sinabung', 'v-agung']).toContain(r.volcano_id);
  });
});

describe('POST /admin/schema-version', () => {
  it('adds confidence_level only to records generated after the toggle', async () => {
    const { app, state } = freshApp();
    await app.inject({ method: 'POST', url: '/admin/schema-version', payload: { enabled: true } });
    addLiveReport(state);

    const data = (await app.inject({ method: 'GET', url: '/volcanic-reports', headers: auth })).json().data;
    const latest = data[data.length - 1];
    const seeded = data.slice(0, 25);

    expect(latest.confidence_level).toBeGreaterThanOrEqual(0);
    expect(latest.confidence_level).toBeLessThanOrEqual(1);
    expect(seeded.every((r: { confidence_level?: number }) => r.confidence_level === undefined)).toBe(true);
  });

  it('rejects a body without a boolean enabled with 400', async () => {
    const { app } = freshApp();
    const res = await app.inject({ method: 'POST', url: '/admin/schema-version' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });
});

describe('POST /admin/outage', () => {
  it('returns 503 PVMBG_OUTAGE immediately and health reports down', async () => {
    const { app } = freshApp();
    await app.inject({ method: 'POST', url: '/admin/outage', payload: { enabled: true } });

    const data = await app.inject({ method: 'GET', url: '/volcanic-reports', headers: auth });
    expect(data.statusCode).toBe(503);
    expect(data.json().error.code).toBe('PVMBG_OUTAGE');

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json().status).toBe('down');
  });

  it('recovers when the outage is disabled', async () => {
    const { app } = freshApp();
    await app.inject({ method: 'POST', url: '/admin/outage', payload: { enabled: true } });
    await app.inject({ method: 'POST', url: '/admin/outage', payload: { enabled: false } });

    const res = await app.inject({ method: 'GET', url: '/volcanic-reports', headers: auth });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a non-boolean enabled with 400', async () => {
    const { app } = freshApp();
    const res = await app.inject({ method: 'POST', url: '/admin/outage', payload: { enabled: 'yes' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('error envelope', () => {
  it('returns ErrorEnvelope for an unknown route', async () => {
    const { app } = freshApp();
    const res = await app.inject({ method: 'GET', url: '/nope', headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
