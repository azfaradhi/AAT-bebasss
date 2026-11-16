import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';
import { createIngestContext, createUnprocessedApp, replayParked, storageClientWriter, unprocessedProvider } from './index';

const AUDIT = { authorization: 'Bearer audit-secret' };

async function seeded() {
  const storage = new InMemoryStorage();
  let now = Date.parse('2026-11-12T02:40:11.456Z');
  const ingest = createIngestContext({ storage, env: {}, clock: () => (now += 1000) });
  const park = (source: 'PVMBG' | 'BMKG', n: number, code: Parameters<typeof ingest.parker.park>[0]['reason_code']) =>
    ingest.parker.park({ source, raw: Buffer.from(`{"n":${n}}`), reason_code: code, detail: `case ${n}`, orderingKey: `k${n}` }, ingest.writeCtx(`k${n}`));
  await park('PVMBG', 1, 'SCHEMA_INCOMPATIBLE');
  await park('PVMBG', 2, 'DOWNSTREAM_UNAVAILABLE');
  await park('BMKG', 3, 'MALFORMED_JSON');
  await park('PVMBG', 4, 'STORAGE_PARTIAL');
  await park('BMKG', 5, 'UNKNOWN_ENUM_VALUE');
  const app = createUnprocessedApp({ parker: ingest.parker, auditToken: 'audit-secret', internalServiceKey: 'svc' });
  return { storage, ingest, app };
}
const get = (app: ReturnType<typeof createUnprocessedApp>, url: string, headers: Record<string, string> = AUDIT) => app.inject({ method: 'GET', url, headers });

describe('GET /internal/audit/unprocessed', () => {
  it('lists retrying and parked items with exactly the Lampiran A fields', async () => {
    const { app } = await seeded();
    const body = (await get(app, '/internal/audit/unprocessed')).json();
    expect(body.items).toHaveLength(5);
    expect(Object.keys(body.items[0]).sort()).toEqual(['attempts', 'message_id', 'reason', 'received_at', 'retryable', 'source', 'status']);
    expect(new Set(body.items.map((i: { status: string }) => i.status))).toEqual(new Set(['retrying', 'parked']));
    expect(body.items.find((i: { retryable: boolean }) => i.retryable)).toMatchObject({ status: 'retrying' });
    expect(body.items[0].received_at).toMatch(/^2026-11-12T02:40:\d\dZ$/);
    expect(body.next_cursor).toBeNull();
  });

  it('pages with a stable cursor: no duplicate, no gap', async () => {
    const { app } = await seeded();
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: Array<{ message_id: string }>; next_cursor: string | null } = (await get(app, `/internal/audit/unprocessed?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json();
      expect(page.items.length).toBeLessThanOrEqual(2);
      ids.push(...page.items.map((i) => i.message_id));
      cursor = page.next_cursor;
    } while (cursor);
    const all = (await get(app, '/internal/audit/unprocessed')).json().items.map((i: { message_id: string }) => i.message_id);
    expect(ids).toEqual(all);
    expect(new Set(ids).size).toBe(5);
  });

  it('filters by source', async () => {
    const { app } = await seeded();
    expect((await get(app, '/internal/audit/unprocessed?source=BMKG')).json().items).toHaveLength(2);
    expect((await get(app, '/internal/audit/unprocessed?source=PVMBG')).json().items).toHaveLength(3);
  });

  it('omits a message once it has been recovered', async () => {
    const { app, ingest, storage } = await seeded();
    const event = { hazard_id: '', source: 'PVMBG', source_ref_id: 'r-9', hazard_type: 'VOLCANIC', severity: 'SIAGA', area_name: 'x', latitude: 0, longitude: 0, occurred_at: '2026-10-04T00:00:00.000Z', ingested_at: '2026-10-04T00:00:01.000Z', attributes: {} };
    await ingest.parker.park({ source: 'PVMBG', raw: Buffer.from(JSON.stringify(event)), reason_code: 'DOWNSTREAM_UNAVAILABLE', detail: 'down', orderingKey: 'r-9' }, ingest.writeCtx('k9'));
    expect((await get(app, '/internal/audit/unprocessed')).json().items).toHaveLength(6);

    await replayParked({ ingest, writer: storageClientWriter(storage, ingest), mapperVersion: 'v2' }, { includeRetryable: true, source: 'PVMBG', reason_code: 'DOWNSTREAM_UNAVAILABLE' });

    const after = (await get(app, '/internal/audit/unprocessed')).json().items;
    expect(after.filter((i: { status: string }) => i.status !== 'retrying' && i.status !== 'parked')).toHaveLength(0);
    expect(after.length).toBeLessThan(6);
  });

  it('rejects a missing or wrong token with 401 and a bad limit or source with 400', async () => {
    const { app } = await seeded();
    expect((await get(app, '/internal/audit/unprocessed', {})).statusCode).toBe(401);
    expect((await get(app, '/internal/audit/unprocessed', { authorization: 'Bearer nope' })).statusCode).toBe(401);
    expect((await get(app, '/internal/audit/unprocessed?limit=0')).statusCode).toBe(400);
    expect((await get(app, '/internal/audit/unprocessed?source=NOPE')).statusCode).toBe(400);
  });

  it('provider output equals the route output (what the audit router will register)', async () => {
    const { app, ingest } = await seeded();
    const viaProvider = await unprocessedProvider(ingest.parker)({ limit: 100 });
    expect(viaProvider).toEqual((await get(app, '/internal/audit/unprocessed')).json());
  });
});

describe('GET /internal/ops/unprocessed', () => {
  it('needs the internal key and adds raw metadata', async () => {
    const { app } = await seeded();
    expect((await get(app, '/internal/ops/unprocessed', {})).statusCode).toBe(401);
    const items = (await get(app, '/internal/ops/unprocessed', { 'x-internal-key': 'svc' })).json().items;
    expect(items[0]).toMatchObject({ raw_truncated: false, raw_size: expect.any(Number), raw_sha256: expect.any(String), reason_code: expect.any(String) });
  });
});
