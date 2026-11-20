import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';
import { registerAudit } from '../audit/audit-router';
import { PollingScheduler } from '../polling/scheduler';
import { CircuitBreaker } from '../resilience/circuit-breaker';
import { ConcurrencyLimiter } from '../resilience/concurrency-limiter';
import { BmkgClient } from '../sources/bmkg-client';
import { PvmbgClient } from '../sources/pvmbg-client';
import { StorageCanonicalStore } from '../storage/storage-canonical-store';
import { createIngestContext } from './context';
import { mountIngest } from './wiring';

// INT-3.4: the real pollers, scheduler, ring-backed store and Audit route over a real HTTP upstream (no fetch stub).
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const AUDIT = { authorization: 'Bearer audit-secret' };
const seismic = (id: string) => ({ event_id: id, magnitude: 4.9, depth_km: 10, epicenter_lat: -6.2, epicenter_lon: 106.8, region_name: 'Region X', occurred_at: '2026-10-06T10:00:00.000Z', potential_tsunami: false });
const volcanic = (id: string) => ({ report_id: id, volcano_id: 'v-merapi', alert_level: 'Siaga', eruption_count_24h: 2, ash_column_height_m: 1200, reported_at: '2026-10-04T00:00:00.000Z' });

let upstream: Server;
let base: string;
let pvmbgBody: () => string;

beforeEach(async () => {
  pvmbgBody = () => JSON.stringify({ data: [volcanic('r-1')] });
  upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/seismic-events')) res.end(JSON.stringify({ data: [seismic('b-1'), { event_id: 'b-bad' }, seismic('b-2')] }));
    else if (req.url?.startsWith('/tsunami-warnings')) res.end(JSON.stringify({ data: [] }));
    else res.end(pvmbgBody());
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => upstream.close(() => r())));

async function setup() {
  const storage = new InMemoryStorage();
  const store = new StorageCanonicalStore({ storage });
  const ingest = createIngestContext({ storage, env: {} });
  const app = Fastify({ logger: false });
  const wiring = mountIngest(app, { storage, internalServiceKey: 'ik', env: {}, ingest });
  registerAudit(app, { storage, providers: wiring.providers, auditToken: 'audit-secret', rateLimitPerSec: 0 });
  const scheduler = new PollingScheduler({
    logger, store, intervalMs: 60_000, lookbackMs: 0,
    bmkg: new BmkgClient({ baseUrl: base, apiKey: 'k', timeoutMs: 1000, logger, ingest }),
    pvmbg: new PvmbgClient({ baseUrl: base, accessToken: 't', timeoutMs: 1000, logger, ingest, circuitBreaker: new CircuitBreaker(5, 1000), limiter: new ConcurrencyLimiter(1) }),
  });
  const unprocessed = async () => (await app.inject({ method: 'GET', url: '/internal/audit/unprocessed', headers: AUDIT })).json().items as Array<{ source: string; reason: string; status: string }>;
  return { storage, scheduler, unprocessed, app };
}

describe('defensive ingest on the real poll path (INT-3.4)', () => {
  it('stores healthy BMKG events, parks the bad one, and shows it on the Audit route', async () => {
    const { storage, scheduler, unprocessed } = await setup();
    await scheduler.runTick();

    const events = await storage.listEvents({ source: 'BMKG', limit: 100 });
    expect(events.items.map((e) => e.source_ref_id).sort()).toEqual(['b-1', 'b-2']);
    const parked = (await unprocessed()).filter((p) => p.source === 'BMKG');
    expect(parked).toHaveLength(1);
    expect(parked[0].status).toBe('parked');
  });

  it('parks a truncated PVMBG response as a whole, keeps BMKG flowing, and recovers on the next healthy poll', async () => {
    const { storage, scheduler, unprocessed } = await setup();
    pvmbgBody = () => '{"data":[{"report_id":';
    await scheduler.runTick();

    expect((await storage.listEvents({ source: 'BMKG', limit: 100 })).items).toHaveLength(2);
    expect((await storage.listEvents({ source: 'PVMBG', limit: 100 })).items).toHaveLength(0);
    expect((await unprocessed()).filter((p) => p.source === 'PVMBG')).toHaveLength(1);

    pvmbgBody = () => JSON.stringify({ data: [volcanic('r-1')] });
    await scheduler.runTick();
    expect((await storage.listEvents({ source: 'PVMBG', limit: 100 })).items).toHaveLength(1);
  });
});
