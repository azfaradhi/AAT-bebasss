import { describe, expect, it, vi } from 'vitest';
import { signAccessToken, TEST_SECRET } from '../test-helpers';
import { buildOpsApp } from './ops-app';

const body = { advisory_available: true, label: 'ADVISORY: automated, not an official assessment', items: [{ hazard_id: 'hz-1', summary_source: 'llm' }] };
const build = (fetchMock: unknown) => {
  vi.stubGlobal('fetch', fetchMock);
  return buildOpsApp({ jwtSecret: TEST_SECRET, aggregatorBaseUrl: 'http://x', internalServiceKey: 'k', advisorBaseUrl: 'http://advisor.test' });
};
const call = (app: ReturnType<typeof build>, token?: string, url = '/ops/advisory') => app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('GET /ops/advisory', () => {
  it('is internal only: 401 / 403 / 403 / 200', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
    const app = build(f);
    expect((await call(app)).statusCode).toBe(401);
    expect((await call(app, signAccessToken('media'))).statusCode).toBe(403);
    expect((await call(app, signAccessToken('lapangan'))).statusCode).toBe(403);
    expect(f).not.toHaveBeenCalled();
    const ok = await call(app, signAccessToken('internal'), '/ops/advisory?limit=5');
    expect(ok.json()).toEqual(body);
    expect(String(f.mock.calls[0][0])).toContain('limit=5');
    expect(f.mock.calls[0][1].headers['x-internal-key']).toBe('k');
  });

  it('answers "no advisory" (200) when the advisor is down, slow or failing: absent means unchanged', async () => {
    for (const f of [vi.fn().mockRejectedValue(new Error('down')), vi.fn().mockResolvedValue(new Response('x', { status: 500 })), vi.fn().mockRejectedValue(Object.assign(new Error('t'), { name: 'TimeoutError' }))]) {
      const res = await call(build(f), signAccessToken('internal'));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ advisory_available: false, items: [] });
    }
  });
});
