import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TEST_SECRET, signAccessToken } from './test-helpers';

const aggregatorClient = { getHazards: async () => ({ data: [], meta: { stale_since: null } }) };

function appWithOps() {
  return buildApp(undefined as never, {
    clientJwtSecret: TEST_SECRET,
    aggregatorClient,
    ops: { aggregatorBaseUrl: 'http://127.0.0.1:1', internalServiceKey: 'k', advisorBaseUrl: 'http://127.0.0.1:1' },
  });
}

describe('ops routes are mounted in the real app', () => {
  it('requires authentication', async () => {
    const res = await appWithOps().inject({ method: 'GET', url: '/ops/unprocessed' });
    expect(res.statusCode).toBe(401);
  });

  it.each([['GET', '/ops/unprocessed'], ['POST', '/ops/replay'], ['GET', '/ops/advisory']] as const)('%s %s is 403 for media and lapangan', async (method, url) => {
    for (const scope of ['media', 'lapangan'] as const) {
      const res = await appWithOps().inject({ method, url, headers: { authorization: `Bearer ${signAccessToken(scope)}` } });
      expect(res.statusCode).toBe(403);
    }
  });

  it('internal scope reaches the route (503 when the aggregator is down, not 404)', async () => {
    const res = await appWithOps().inject({ method: 'GET', url: '/ops/unprocessed', headers: { authorization: `Bearer ${signAccessToken('internal')}` } });
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).not.toBe(403);
  });

  it('stays absent when ops is not configured', async () => {
    const app = buildApp(undefined as never, { clientJwtSecret: TEST_SECRET, aggregatorClient });
    const res = await app.inject({ method: 'GET', url: '/ops/unprocessed', headers: { authorization: `Bearer ${signAccessToken('internal')}` } });
    expect(res.statusCode).toBe(404);
  });
});
