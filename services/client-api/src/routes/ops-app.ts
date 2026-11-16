import Fastify, { type FastifyInstance } from 'fastify';
import type { ErrorEnvelope } from '../../../../shared-types/src/envelopes';
import { AppError } from '../errors';
import { createAuthMiddleware } from '../middleware/auth';
import { bindCorrelationId } from '../middleware/correlation-id';
import { registerOpsReplayRoute } from './ops-replay';
import { registerOpsUnprocessedRoute } from './ops-unprocessed';

export interface OpsAppOptions { jwtSecret: string; aggregatorBaseUrl: string; internalServiceKey: string }

// The two Ops routes behind client authentication, as their own app (used by demos and tests).
export function buildOpsApp(opts: OpsAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', bindCorrelationId);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof AppError) return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } } satisfies ErrorEnvelope);
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } } satisfies ErrorEnvelope);
  });
  app.register(async (routes) => {
    routes.addHook('preHandler', createAuthMiddleware(opts.jwtSecret));
    registerOpsUnprocessedRoute(routes, opts);
    registerOpsReplayRoute(routes, opts);
  });
  return app;
}
