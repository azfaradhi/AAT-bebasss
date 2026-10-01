import Fastify, { FastifyBaseLogger, FastifyError, FastifyInstance } from 'fastify';
import type { ErrorEnvelope, HealthResponse } from '../../../shared-types/src/envelopes';
import { bindCorrelationId } from './middleware/correlationId';
import { createAuthMiddleware } from './middleware/auth';
import { registerDevStubHazardsRoute } from './dev-stub-hazards-route';
import { AppError } from './errors';

export const SERVICE_NAME = 'client-api';

export interface AppDeps {
  clientJwtSecret: string;
}

export function buildApp(logger: FastifyBaseLogger | undefined, deps: AppDeps): FastifyInstance {
  const app = Fastify(logger ? { loggerInstance: logger } : { logger: false });

  app.addHook('onRequest', bindCorrelationId);

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

  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  }));

  // Child context so the auth hook doesn't also apply to /health above.
  app.register(async (protectedRoutes) => {
    protectedRoutes.addHook('preHandler', createAuthMiddleware(deps.clientJwtSecret));
    registerDevStubHazardsRoute(protectedRoutes);
  });

  return app;
}
