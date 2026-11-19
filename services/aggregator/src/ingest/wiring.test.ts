import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';
import { registerAudit } from '../audit/audit-router';
import { CircuitBreaker } from '../resilience/circuit-breaker';
import { ConcurrencyLimiter } from '../resilience/concurrency-limiter';
import { PvmbgClient } from '../sources/pvmbg-client';
import { mountIngest } from './wiring';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
afterEach(() => vi.unstubAllGlobals());

const AUDIT = { authorization: 'Bearer audit-secret' };
const OPS = { 'x-internal-key': 'ik' };
const renamed = (id: string) => ({ report_id: id, volcano_code: 'v-merapi', alert_level: 'Siaga', eruption_count_24h: 2, ash_column_height_m: 1200, reported_at: '2026-10-04T00:00:00.000Z' });

async function setup(mapperVersion: 'v1' | 'v2' = 'v1') {
  const storage = new InMemoryStorage();
  const app = Fastify({ logger: false });
  const wiring = mountIngest(app, { storage, internalServiceKey: 'ik', env: {}, mapperVersion });
  registerAudit(app, { storage, providers: wiring.providers, auditToken: 'audit-secret' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [renamed('r-1'), renamed('r-2')] }), { headers: { 'content-type': 'application/json' } })));
  const client = new PvmbgClient({ baseUrl: 'http://p.test', accessToken: 't', timeoutMs: 1000, logger, ingest: wiring.ingest, mapperVersion: 'v1', circuitBreaker: new CircuitBreaker(3, 1000), limiter: new ConcurrencyLimiter(1) });
  await client.poll();
  return { app, storage };
}

describe('mountIngest on the aggregator app together with the Audit router', () => {
  it('serves parked messages on the Audit route (no duplicate route) and the ops route', async () => {
    const { app } = await setup();
    const audit = await app.inject({ method: 'GET', url: '/internal/audit/unprocessed', headers: AUDIT });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().items).toHaveLength(2);
    const ops = await app.inject({ method: 'GET', url: '/internal/ops/unprocessed', headers: OPS });
    expect(ops.statusCode).toBe(200);
    expect(ops.json().items[0]).toHaveProperty('reason_code');
  });

  it('rejects ops calls without the internal key', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/internal/ops/unprocessed' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/internal/ops/replay' })).statusCode).toBe(401);
  });

  it('replay recovers the parked messages and they leave the Audit list', async () => {
    const { app, storage } = await setup('v2');
    const res = await app.inject({ method: 'POST', url: '/internal/ops/replay', headers: OPS, payload: {} });
    expect(res.json()).toMatchObject({ considered: 2, recovered: 2, still_failing: 0 });
    expect((await storage.listEvents({ source: 'PVMBG' as never, limit: 10 })).items).toHaveLength(2);
    expect((await app.inject({ method: 'GET', url: '/internal/audit/unprocessed', headers: AUDIT })).json().items).toHaveLength(0);
  });
});
