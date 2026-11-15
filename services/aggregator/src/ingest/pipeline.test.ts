import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HazardEvent } from '../../../../shared-types/src/hazard-event';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';
import { BmkgClient } from '../sources/bmkg-client';
import { PvmbgClient } from '../sources/pvmbg-client';
import { CircuitBreaker } from '../resilience/circuit-breaker';
import { ConcurrencyLimiter } from '../resilience/concurrency-limiter';
import type { CanonicalStore } from '../storage/canonical-store';
import { createIngestContext, fetchGuarded, IngestRetrySweeper, ParkingStore, storeRetryHandler } from './index';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
afterEach(() => vi.unstubAllGlobals());

const good = { report_id: 'r-1', volcano_id: 'v-merapi', alert_level: 'Siaga', eruption_count_24h: 2, ash_column_height_m: 1200, reported_at: '2026-10-04T00:00:00.000Z' };
const json = (body: unknown, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'content-type': type } });
const bytes = (...b: number[]) => new Response(new Uint8Array(b), { headers: { 'content-type': 'application/json' } });
const env = (over: Record<string, string> = {}) => ({ ...over });

function setup(over: Record<string, string> = {}) {
  const ingest = createIngestContext({ storage: new InMemoryStorage(), env: env(over) });
  const client = () => new PvmbgClient({
    baseUrl: 'http://pvmbg.test', accessToken: 't', timeoutMs: 1000, logger, ingest,
    circuitBreaker: new CircuitBreaker(3, 1000), limiter: new ConcurrencyLimiter(1),
  });
  return { ingest, client };
}
const unprocessed = async (ingest: ReturnType<typeof setup>['ingest']) => (await ingest.parker.listUnprocessed({ limit: 100 })).items;

describe('response guarding', () => {
  it.each([
    ['truncated JSON', () => json('{"data":[{"a":'), 'MALFORMED_JSON'],
    ['empty body', () => json(''), 'MALFORMED_JSON'],
    ['invalid UTF-8', () => bytes(0x7b, 0xc3, 0x28, 0x7d), 'INVALID_UTF8'],
    ['NUL bytes', () => json('{"data":[]}\u0000'), 'MALFORMED_JSON'],
    ['wrong content type', () => json({ data: [] }, 'text/html'), 'MALFORMED_JSON'],
    ['deep nesting', () => json('['.repeat(10_000) + ']'.repeat(10_000)), 'NESTING_TOO_DEEP'],
    ['oversized body', () => json(JSON.stringify({ data: ['x'.repeat(300_000)] })), 'PAYLOAD_TOO_LARGE'],
    ['no data array', () => json({ items: [] }), 'SCHEMA_INCOMPATIBLE'],
  ])('parks %s as %s and fails the poll without throwing past the client', async (_name, make, code) => {
    const { ingest, client } = setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(make()));

    await expect(client().poll()).rejects.toThrow(/response parked/);

    const items = await unprocessed(ingest);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'PVMBG', reason_code: code, status: 'parked', retryable: false });
  });

  it('stops reading an oversized stream instead of buffering it', async () => {
    const { ingest } = setup({ MAX_MESSAGE_BYTES: '1000' });
    const pulled: number[] = [];
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled.push(1); c.enqueue(new Uint8Array(600)); if (pulled.length > 50) c.close(); } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'application/json' } })));

    await expect(fetchGuarded(ingest, 'PVMBG', new URL('http://x/y'), {}, 1000, logger)).rejects.toThrow();

    expect(pulled.length).toBeLessThan(10);
  });

  it('does not park a transport failure (nothing to park)', async () => {
    const { ingest, client } = setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 503 })));
    await expect(client().poll()).rejects.toThrow(/HTTP 503/);
    expect(await unprocessed(ingest)).toHaveLength(0);
  });

  it('sends the instance header upstream', async () => {
    const { ingest } = setup();
    const fetchMock = vi.fn().mockResolvedValue(json({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchGuarded(ingest, 'PVMBG', new URL('http://x/y'), {}, 1000, logger);
    expect(fetchMock.mock.calls[0][1].headers['x-aggregator-instance']).toBeTruthy();
  });
});

describe('per-item isolation', () => {
  it('stores healthy items and parks each bad one with its reason', async () => {
    const { ingest, client } = setup();
    const batch = [
      good,
      { ...good, report_id: 'r-2', volcano_id: undefined, volcano_code: 'v-merapi' },
      { ...good, report_id: 'r-3', alert_level: 'Siaga-II' },
      null,
      { ...good, report_id: 'r-5' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ data: batch })));

    const hazards = await client().poll();

    expect(hazards.map((h) => h.source_ref_id)).toEqual(['r-1', 'r-5']);
    const parked = await unprocessed(ingest);
    expect(parked.map((p) => p.reason_code).sort()).toEqual(['SCHEMA_INCOMPATIBLE', 'SCHEMA_INCOMPATIBLE', 'UNKNOWN_ENUM_VALUE']);
    expect(parked.every((p) => !p.retryable)).toBe(true);
  });

  it('parks a malformed BMKG event without losing the others', async () => {
    const { ingest } = setup();
    const event = { event_id: 'e-1', region_name: 'x', epicenter_lat: -1, epicenter_lon: 100, occurred_at: '2026-10-04T00:00:00.000Z', magnitude: 5.5, depth_km: 10, potential_tsunami: false };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ data: [event, { ...event, event_id: 'e-2', magnitude: 'big' }] }))
      .mockResolvedValueOnce(json({ data: [] })));
    const bmkg = new BmkgClient({ baseUrl: 'http://bmkg.test', apiKey: 'k', timeoutMs: 1000, logger, ingest });

    const hazards = await bmkg.poll();

    expect(hazards.map((h) => h.source_ref_id)).toEqual(['e-1']);
    expect((await unprocessed(ingest))[0]).toMatchObject({ source: 'BMKG', reason_code: 'SCHEMA_INCOMPATIBLE' });
  });

  it('parking the same bad record twice yields one record', async () => {
    const { ingest, client } = setup();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json({ data: [{ ...good, alert_level: 'X' }] })));
    await client().poll();
    await client().poll();
    expect(await unprocessed(ingest)).toHaveLength(1);
  });
});

describe('store failures and the retry sweeper', () => {
  const event: HazardEvent = {
    hazard_id: 'h-1', source: 'PVMBG', source_ref_id: 'r-1', hazard_type: 'VOLCANIC', severity: 'SIAGA', area_name: 'a',
    latitude: 0, longitude: 0, occurred_at: '2026-10-04T00:00:00.000Z', ingested_at: '2026-10-04T00:00:00.000Z', attributes: {},
  };
  function flakyStore() {
    const state = { down: true, saved: [] as string[] };
    const inner = {
      upsert: vi.fn(async (e: HazardEvent) => { if (state.down) throw new Error('connection refused'); state.saved.push(e.source_ref_id); return { event: e, created: true }; }),
    } as unknown as CanonicalStore;
    return { state, inner };
  }

  it('parks an unstorable event as retrying and the sweeper recovers it once storage is back', async () => {
    let now = 1_000_000;
    const ingest = createIngestContext({ storage: new InMemoryStorage(), env: env(), clock: () => now });
    const { state, inner } = flakyStore();
    const store = new ParkingStore(inner, ingest);

    await store.upsert(event, 'c-1');
    const [parked] = await unprocessed(ingest);
    expect(parked).toMatchObject({ status: 'retrying', reason_code: 'DOWNSTREAM_UNAVAILABLE', retryable: true });

    const sweeper = new IngestRetrySweeper({ ingest, handler: storeRetryHandler(inner), intervalMs: 1000, logger, now: () => now });
    now += 120_000;
    state.down = false;
    await sweeper.tick();

    expect(state.saved).toEqual(['r-1']);
    expect(await unprocessed(ingest)).toHaveLength(0);
  });

  it('applies backoff and ends in RETRIES_EXHAUSTED after PARK_MAX_ATTEMPTS', async () => {
    let now = 1_000_000;
    const ingest = createIngestContext({ storage: new InMemoryStorage(), env: env({ PARK_MAX_ATTEMPTS: '3' }), clock: () => now });
    const { inner } = flakyStore();
    const store = new ParkingStore(inner, ingest);
    const sweeper = new IngestRetrySweeper({ ingest, handler: storeRetryHandler(inner), intervalMs: 1000, logger, now: () => now });
    await store.upsert(event, 'c-1');

    await sweeper.tick(); // not yet due: nothing happens
    expect((await unprocessed(ingest))[0].attempts).toBe(1);

    for (let i = 0; i < 2; i++) { now += 120_000; await sweeper.tick(); }

    expect((await unprocessed(ingest))[0]).toMatchObject({ status: 'parked', reason_code: 'RETRIES_EXHAUSTED', attempts: 3 });
  });
});
