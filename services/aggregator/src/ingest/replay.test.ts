import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hazardId } from '../../../../shared-types/src/m2/ids';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';
import { CircuitBreaker } from '../resilience/circuit-breaker';
import { ConcurrencyLimiter } from '../resilience/concurrency-limiter';
import { PvmbgClient } from '../sources/pvmbg-client';
import { createIngestContext, registerReplayRoute, replayParked, storageClientWriter } from './index';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
afterEach(() => vi.unstubAllGlobals());

const good = (id: string, over: Record<string, unknown> = {}) => ({
  report_id: id, volcano_id: 'v-merapi', alert_level: 'Siaga', eruption_count_24h: 2, ash_column_height_m: 1200, reported_at: '2026-10-04T00:00:00.000Z', ...over,
});
const renamed = (id: string) => { const r: Record<string, unknown> = good(id); r.volcano_code = r.volcano_id; delete r.volcano_id; return r; };
const retyped = (id: string) => good(id, { eruption_count_24h: '7' });
const dropped = (id: string) => { const r = good(id); delete (r as Record<string, unknown>).ash_column_height_m; return r; };

function setup() {
  const storage = new InMemoryStorage();
  const ingest = createIngestContext({ storage, env: {} });
  const writer = storageClientWriter(storage, ingest);
  const poll = async (records: unknown[], mapperVersion: 'v1' | 'v2' = 'v1') => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: records }), { headers: { 'content-type': 'application/json' } })));
    const client = new PvmbgClient({
      baseUrl: 'http://pvmbg.test', accessToken: 't', timeoutMs: 1000, logger, ingest, mapperVersion,
      circuitBreaker: new CircuitBreaker(3, 1000), limiter: new ConcurrencyLimiter(1),
    });
    for (const event of await client.poll()) await writer.write({ ...event, hazard_id: hazardId('PVMBG', event.source_ref_id), ingested_at: new Date().toISOString() }, 'c');
  };
  const stored = async () => (await storage.listEvents({ source: 'PVMBG' as never, limit: 100 })).items;
  const unprocessed = async () => (await ingest.parker.listUnprocessed({ limit: 100 })).items;
  return { storage, ingest, writer, poll, stored, unprocessed, replay: (v: 'v1' | 'v2' = 'v2') => replayParked({ ingest, writer, mapperVersion: v }, {}) };
}

describe('mapper v2 and replay', () => {
  it('parks rename and type change under v1, recovers them with v2, and leaves a dropped required field parked', async () => {
    const h = setup();
    await h.poll([good('r-ok'), renamed('r-rename'), retyped('r-type'), dropped('r-drop')]);
    expect((await h.stored()).map((e) => e.source_ref_id)).toEqual(['r-ok']);
    expect(await h.unprocessed()).toHaveLength(3);

    const report = await h.replay();

    expect(report).toMatchObject({ considered: 3, recovered: 2, still_failing: 1, per_key_order_violations: 0 });
    expect((await h.stored()).map((e) => e.source_ref_id).sort()).toEqual(['r-ok', 'r-rename', 'r-type']);
    const left = await h.unprocessed();
    expect(left).toHaveLength(1);
    expect(left[0].ordering_key).toBe('r-drop');
  });

  it('is idempotent: a second replay changes nothing and creates no duplicate', async () => {
    const h = setup();
    await h.poll([renamed('r-1'), retyped('r-2')]);
    await h.replay();
    const eventsAfterFirst = JSON.stringify(await h.stored());

    const second = await h.replay();

    expect(second).toMatchObject({ considered: 0, recovered: 0, skipped_already_recovered: 2 });
    expect(JSON.stringify(await h.stored())).toBe(eventsAfterFirst);
  });

  it('a replayed message and a later fresh poll of the same record yield one event', async () => {
    const h = setup();
    await h.poll([renamed('r-1')]);
    await h.replay();
    await h.poll([good('r-1')], 'v2'); // the source sends the record again, now in the new shape
    expect(await h.stored()).toHaveLength(1);
  });

  it('replays messages of one ordering key in arrival order (the first arrival wins, as in a fault-free run)', async () => {
    const h = setup();
    let now = 1_000;
    const ingest = createIngestContext({ storage: h.storage, env: {}, clock: () => now++ });
    for (const level of ['Siaga', 'Awas']) {
      await ingest.parker.park({ source: 'PVMBG', raw: Buffer.from(JSON.stringify({ ...renamed('r-1'), alert_level: level })), reason_code: 'SCHEMA_INCOMPATIBLE', detail: 'x', orderingKey: 'r-1' }, ingest.writeCtx('k'));
    }
    const seen: string[] = [];
    const base = replayParked({ ingest, writer: { write: async (e) => { seen.push(e.severity); await h.writer.write(e, 'c'); } }, mapperVersion: 'v2' }, {});
    const report = await base;
    expect(report.recovered).toBe(2);
    expect(seen).toEqual(['SIAGA', 'AWAS']);
    expect((await h.stored())[0].severity).toBe('SIAGA');
  });

  it('recovers an already-mapped event that was parked after a failed store write', async () => {
    const h = setup();
    const event = { hazard_id: '', source: 'PVMBG', source_ref_id: 'r-9', hazard_type: 'VOLCANIC', severity: 'SIAGA', area_name: 'Gunung Merapi', latitude: -7.5, longitude: 110.4, occurred_at: '2026-10-04T00:00:00.000Z', ingested_at: '2026-10-04T00:00:01.000Z', attributes: {} };
    await h.ingest.parker.park({ source: 'PVMBG', raw: Buffer.from(JSON.stringify(event)), reason_code: 'DOWNSTREAM_UNAVAILABLE', detail: 'down', orderingKey: 'r-9' }, h.ingest.writeCtx('k'));
    const report = await replayParked({ ingest: h.ingest, writer: h.writer, mapperVersion: 'v2' }, { includeRetryable: true });
    expect(report.recovered).toBe(1);
    expect((await h.stored())[0].source_ref_id).toBe('r-9');
  });
});

describe('POST /internal/ops/replay', () => {
  function app() {
    const h = setup();
    const fastify = Fastify({ logger: false });
    registerReplayRoute(fastify, { ingest: h.ingest, writer: h.writer, mapperVersion: 'v2' }, 'secret');
    return { h, fastify };
  }

  it('rejects a missing key with 401 and a bad body with 400', async () => {
    const { fastify } = app();
    expect((await fastify.inject({ method: 'POST', url: '/internal/ops/replay' })).statusCode).toBe(401);
    const bad = await fastify.inject({ method: 'POST', url: '/internal/ops/replay', headers: { 'x-internal-key': 'secret' }, payload: { source: 'NOPE' } });
    expect(bad.statusCode).toBe(400);
  });

  it('returns the replay report', async () => {
    const { h, fastify } = app();
    await h.poll([renamed('r-1')]);
    const res = await fastify.inject({ method: 'POST', url: '/internal/ops/replay', headers: { 'x-internal-key': 'secret' }, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ considered: 1, recovered: 1, still_failing: 0 });
  });
});
