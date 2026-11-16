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

describe('POST /admin/schema-version {mode}', () => {
  async function latestAfter(mode: string) {
    const { app, state } = freshApp();
    const res = await app.inject({ method: 'POST', url: '/admin/schema-version', payload: { mode } });
    expect(res.json().mode).toBe(mode);
    addLiveReport(state);
    const data = (await app.inject({ method: 'GET', url: '/volcanic-reports', headers: auth })).json().data;
    return { latest: data[data.length - 1], seeded: data[0] };
  }

  it('additive adds an optional field, a float height and sometimes null', async () => {
    const { latest } = await latestAfter('additive');
    expect(latest.observer_note).toBeDefined();
    expect(latest.volcano_id).toBeDefined();
    expect(Number.isInteger(latest.ash_column_height_m)).toBe(false);
  });

  it('rename replaces volcano_id with volcano_code', async () => {
    const { latest } = await latestAfter('rename');
    expect(latest.volcano_id).toBeUndefined();
    expect(latest.volcano_code).toBeDefined();
  });

  it('type_change makes eruption_count_24h a string', async () => {
    const { latest } = await latestAfter('type_change');
    expect(typeof latest.eruption_count_24h).toBe('string');
  });

  it('drop_required removes ash_column_height_m, leaving older records untouched', async () => {
    const { latest, seeded } = await latestAfter('drop_required');
    expect(latest.ash_column_height_m).toBeUndefined();
    expect(seeded.ash_column_height_m).toBeDefined();
  });

  it('baseline restores the original shape', async () => {
    const { app, state } = freshApp();
    await app.inject({ method: 'POST', url: '/admin/schema-version', payload: { mode: 'rename' } });
    await app.inject({ method: 'POST', url: '/admin/schema-version', payload: { mode: 'baseline' } });
    addLiveReport(state);
    const data = (await app.inject({ method: 'GET', url: '/volcanic-reports', headers: auth })).json().data;
    expect(data[data.length - 1].volcano_id).toBeDefined();
  });

  it('rejects an unknown mode with 400', async () => {
    const { app } = freshApp();
    const res = await app.inject({ method: 'POST', url: '/admin/schema-version', payload: { mode: 'chaos' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });
});

describe('request log, /ready and /metrics', () => {
  it('logs data requests with caller_instance and correlation id, not probes', async () => {
    const { app } = freshApp();
    await app.inject({ method: 'GET', url: '/volcanic-reports', headers: { ...auth, 'x-aggregator-instance': 'agg-1', 'x-correlation-id': 'c-1' } });
    await app.inject({ method: 'GET', url: '/health' });

    const log = (await app.inject({ method: 'GET', url: '/admin/request-log' })).json().data;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ method: 'GET', path: '/volcanic-reports', status: 200, caller_instance: 'agg-1', correlation_id: 'c-1' });
  });

  it('filters by since and rejects a bad timestamp', async () => {
    const { app } = freshApp();
    await app.inject({ method: 'GET', url: '/volcanic-reports', headers: auth });
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await app.inject({ method: 'GET', url: `/admin/request-log?since=${future}` })).json().data).toHaveLength(0);
    expect((await app.inject({ method: 'GET', url: '/admin/request-log?since=nope' })).statusCode).toBe(400);
  });

  it('serves /ready and Prometheus /metrics without auth', async () => {
    const { app } = freshApp();
    await app.inject({ method: 'GET', url: '/volcanic-reports', headers: auth });
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('mock_http_requests_total{service="pvmbg-mock",method="GET",path="/volcanic-reports",status="200"} 1');
    expect(metrics.body).toContain('bnpb_http_server_request_duration_seconds_count{service="pvmbg-mock",route="/volcanic-reports",method="GET",status_class="2xx"} 1');
  });
});

describe('POST /admin/fuzz', () => {
  it('serves the chosen hostile response until reset', async () => {
    const { app } = freshApp();
    await app.inject({ method: 'POST', url: '/admin/fuzz', payload: { case: 'empty_body' } });
    expect((await app.inject({ method: 'GET', url: '/volcanic-reports', headers: auth })).body).toBe('');

    await app.inject({ method: 'POST', url: '/admin/fuzz', payload: { case: 'wrong_content_type' } });
    expect((await app.inject({ method: 'GET', url: '/volcanic-reports', headers: auth })).headers['content-type']).toContain('text/html');

    await app.inject({ method: 'POST', url: '/admin/fuzz', payload: { case: null } });
    expect((await app.inject({ method: 'GET', url: '/volcanic-reports', headers: auth })).json().data.length).toBeGreaterThan(20);
  });

  it('rejects an unknown case with 400', async () => {
    const { app } = freshApp();
    expect((await app.inject({ method: 'POST', url: '/admin/fuzz', payload: { case: 'nope' } })).statusCode).toBe(400);
  });
});
