import { describe, expect, it, vi } from 'vitest';
import { signAccessToken, TEST_SECRET } from '../test-helpers';
import { buildOpsApp } from './ops-app';

const items = { items: [{ message_id: 'msg-1', source: 'PVMBG', received_at: '2026-11-12T02:40:11Z', reason: 'x', retryable: false, attempts: 1, status: 'parked', raw_size: 10 }], next_cursor: null };
const build = (fetchMock: unknown) => {
  vi.stubGlobal('fetch', fetchMock);
  return buildOpsApp({ jwtSecret: TEST_SECRET, aggregatorBaseUrl: 'http://aggregator.test', internalServiceKey: 'k' });
};
const call = (app: ReturnType<typeof build>, token?: string, url = '/ops/unprocessed') => app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('GET /ops/unprocessed', () => {
  it('answers 401 / 403 / 403 / 200 for none / media / lapangan / internal, calling the aggregator only for internal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(items), { status: 200 }));
    const app = build(fetchMock);
    expect((await call(app)).statusCode).toBe(401);
    expect((await call(app, signAccessToken('media'))).statusCode).toBe(403);
    expect((await call(app, signAccessToken('lapangan'))).statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    const ok = await call(app, signAccessToken('internal'));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(items);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forwards source, limit and cursor and the service key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(items), { status: 200 }));
    await call(build(fetchMock), signAccessToken('internal'), '/ops/unprocessed?source=PVMBG&limit=5&cursor=abc');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/internal/ops/unprocessed');
    expect(url).toContain('source=PVMBG');
    expect(url).toContain('limit=5');
    expect(url).toContain('cursor=abc');
    expect(fetchMock.mock.calls[0][1].headers['x-internal-key']).toBe('k');
  });

  it('answers 503 when the aggregator is down and 400 for its bad-request', async () => {
    expect((await call(build(vi.fn().mockRejectedValue(new Error('down'))), signAccessToken('internal'))).statusCode).toBe(503);
    expect((await call(build(vi.fn().mockResolvedValue(new Response('{}', { status: 400 }))), signAccessToken('internal'))).statusCode).toBe(400);
  });
});
