import Fastify, { type FastifyInstance } from 'fastify';
import type { ErrorEnvelope } from '../../../../shared-types/src/envelopes';
import { AppError } from '../errors';
import { createAuthMiddleware } from '../middleware/auth';
import { bindCorrelationId } from '../middleware/correlation-id';
import type { FieldReportStore } from '../../../../shared-types/src/field-reports';
import { registerFieldReportsRoute } from './field-reports';
import { registerOpsReplayRoute } from './ops-replay';
import { registerOpsUnprocessedRoute } from './ops-unprocessed';

export interface OpsAppOptions { jwtSecret: string; aggregatorBaseUrl: string; internalServiceKey: string; fieldReportStore?: FieldReportStore }

// The Ops routes (and the field-report intake when a store is given) behind client authentication, as their own app (used by demos and tests).
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
    if (opts.fieldReportStore) registerFieldReportsRoute(routes, { store: opts.fieldReportStore });
  });
  return app;
}
