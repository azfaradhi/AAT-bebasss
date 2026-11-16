import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createAuthMiddleware } from '../middleware/auth';
import { signAccessToken, TEST_SECRET } from '../test-helpers';
import { AppError } from '../errors';
import { registerOpsReplayRoute } from './ops-replay';

function app(fetchImpl: typeof fetch) {
  const fastify = Fastify({ logger: false });
  fastify.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'x' } });
  });
  fastify.register(async (routes) => {
    routes.addHook('preHandler', createAuthMiddleware(TEST_SECRET));
    registerOpsReplayRoute(routes, { aggregatorBaseUrl: 'http://aggregator.test', internalServiceKey: 'k', fetchImpl });
  });
  return fastify;
}
const report = { considered: 2, recovered: 2, still_failing: 0, skipped_already_recovered: 0, per_key_order_violations: 0 };
const call = (a: ReturnType<typeof app>, token?: string) => a.inject({ method: 'POST', url: '/ops/replay', headers: token ? { authorization: `Bearer ${token}` } : {}, payload: { source: 'PVMBG' } });

describe('POST /ops/replay', () => {
  it('is 401 without a token and 403 for media and lapangan, without calling the aggregator', async () => {
    const fetchImpl = vi.fn();
    const a = app(fetchImpl as never);
    expect((await call(a)).statusCode).toBe(401);
    expect((await call(a, signAccessToken('media'))).statusCode).toBe(403);
    expect((await call(a, signAccessToken('lapangan'))).statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards an internal request with the service key and returns the report', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(report), { status: 200 }));
    const res = await call(app(fetchImpl as never), signAccessToken('internal'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(report);
    expect(fetchImpl.mock.calls[0][1].headers['x-internal-key']).toBe('k');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ source: 'PVMBG' });
  });

  it('answers 503 when the aggregator is unreachable and 502 on its error', async () => {
    expect((await call(app(vi.fn().mockRejectedValue(new Error('down')) as never), signAccessToken('internal'))).statusCode).toBe(503);
    expect((await call(app(vi.fn().mockResolvedValue(new Response('x', { status: 500 })) as never), signAccessToken('internal'))).statusCode).toBe(502);
  });
});
