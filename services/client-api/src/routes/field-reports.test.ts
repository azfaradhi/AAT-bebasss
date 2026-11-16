import { describe, expect, it } from 'vitest';
import { FieldReportStore } from '../../../../shared-types/src/field-reports';
import { InMemoryStorage } from '../../../aggregator/test-support/contract-fakes/fakes/in-memory-storage';
import { signAccessToken, TEST_SECRET } from '../test-helpers';
import { buildOpsApp } from './ops-app';

const report = { category: 'KERUSAKAN', description: 'jembatan putus', latitude: -2, longitude: 110, observed_at: '2026-11-17T01:00:00Z' };

function build() {
  const storage = new InMemoryStorage();
  const store = new FieldReportStore(storage);
  const app = buildOpsApp({ jwtSecret: TEST_SECRET, aggregatorBaseUrl: 'http://x', internalServiceKey: 'k', fieldReportStore: store });
  return { storage, store, app };
}
const post = (app: ReturnType<typeof build>['app'], payload: unknown, opts: { scope?: 'media' | 'lapangan' | 'internal'; key?: string | null; token?: boolean } = {}) =>
  app.inject({
    method: 'POST', url: '/field-reports', payload: payload as never,
    headers: {
      ...(opts.token === false ? {} : { authorization: `Bearer ${signAccessToken(opts.scope ?? 'lapangan')}` }),
      ...(opts.key === null ? {} : { 'idempotency-key': opts.key ?? 'key-1' }),
    },
  });

describe('POST /field-reports', () => {
  it('answers 202 with the report id only after the report is stored', async () => {
    const { app, storage } = build();
    const res = await post(app, report);
    expect(res.statusCode).toBe(202);
    const json = res.json();
    expect(json).toMatchObject({ status: 'accepted', report_id: expect.stringMatching(/^fr-/) });
    expect(await storage.getDoc('field_reports', `r:${json.report_id}`)).toMatchObject({ reporter: 'lapangan-client', processed_at: null });
  });

  it('is idempotent: the same key twice gives the same id and one report', async () => {
    const { app, store } = build();
    const a = (await post(app, report)).json();
    const b = (await post(app, report)).json();
    expect(b.report_id).toBe(a.report_id);
    expect(b.received_at).toBe(a.received_at);
    expect(await store.audit({ limit: 10 })).toMatchObject({ accepted_total: 1, duplicates_dropped_total: 1 });
  });

  it('takes the reporter from the token, never from the body', async () => {
    const { app, storage } = build();
    const id = (await post(app, { ...report, reporter: 'someone-else' })).json().report_id;
    expect((await storage.getDoc<{ reporter: string }>('field_reports', `r:${id}`))!.reporter).toBe('lapangan-client');
  });

  it('rejects: no token 401, media and internal 403, missing key 400, bad body 400, oversized 413', async () => {
    const { app } = build();
    expect((await post(app, report, { token: false })).statusCode).toBe(401);
    expect((await post(app, report, { scope: 'media' })).statusCode).toBe(403);
    expect((await post(app, report, { scope: 'internal' })).statusCode).toBe(403);
    expect((await post(app, report, { key: null })).statusCode).toBe(400);
    expect((await post(app, report, { key: 'k'.repeat(201) })).statusCode).toBe(400);
    expect((await post(app, { ...report, category: 'X' })).statusCode).toBe(400);
    const big = await post(app, { ...report, description: 'a'.repeat(20_000) });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('answers 503 with Retry-After, never 202, when the ring is unavailable', async () => {
    const { app, storage } = build();
    for (const unit of storage.units()) storage.setUnitState(unit, 'DOWN');
    const res = await post(app, report);
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
  });
});
