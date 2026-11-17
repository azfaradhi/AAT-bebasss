import Fastify, { FastifyBaseLogger, FastifyError, FastifyInstance } from 'fastify';
import type { ErrorEnvelope, HealthResponse } from '../../../shared-types/src/envelopes';
import { bindCorrelationId } from './middleware/correlation-id';
import { createAuthMiddleware } from './middleware/auth';
import { PriorityAdmissionController, createAdmissionHooks } from './middleware/admission';
import type { AggregatorClient } from './clients/aggregator-client';
import { registerHazardsRoute } from './routes/hazards';
import { AppError } from './errors';
import { registerHttpMetrics } from './obs/index';

export const SERVICE_NAME = 'client-api';

export interface AppDeps {
  clientJwtSecret: string;
  aggregatorClient: AggregatorClient;
  jwtClockToleranceSeconds?: number;
  admissionController?: PriorityAdmissionController;
}

export function buildApp(logger: FastifyBaseLogger | undefined, deps: AppDeps): FastifyInstance {
  const app = Fastify(logger ? { loggerInstance: logger } : { logger: false });

  registerHttpMetrics(app, SERVICE_NAME);
  app.addHook('onRequest', bindCorrelationId);

  const admissionHooks = deps.admissionController ? createAdmissionHooks(deps.admissionController) : null;
  if (admissionHooks) {
    app.addHook('onResponse', admissionHooks.onRelease);
    app.addHook('onError', admissionHooks.onRelease);
  }

  app.setNotFoundHandler((_request, reply) => {
    const body: ErrorEnvelope = { error: { code: 'NOT_FOUND', message: 'Route not found' } };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof AppError) {
      const body: ErrorEnvelope = { error: { code: err.code, message: err.message } };
      return reply.code(err.statusCode).send(body);
    }
    request.log.error({ err }, 'unhandled error');
    const body: ErrorEnvelope = { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };
    return reply.code(500).send(body);
  });

  const healthHandler = async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  });
  app.get('/health', healthHandler);
  app.get('/healthz', healthHandler);

  // Child context so the auth hook doesn't also apply to /health above.
  app.register(async (protectedRoutes) => {
    protectedRoutes.addHook('preHandler', createAuthMiddleware(deps.clientJwtSecret, deps.jwtClockToleranceSeconds ?? 0));
    if (admissionHooks) {
      protectedRoutes.addHook('preHandler', admissionHooks.preHandler);
    }
    registerHazardsRoute(protectedRoutes, deps.aggregatorClient);
  });

  return app;
}
