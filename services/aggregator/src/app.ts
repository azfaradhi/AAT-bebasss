import Fastify, { FastifyBaseLogger, FastifyError, FastifyInstance } from 'fastify';
import type { ErrorEnvelope, HealthResponse } from '../../../shared-types/src/envelopes';
import type { CanonicalStore } from './storage/canonical-store';
import { registerInternalHazardsRoute } from './internal-api/hazards-route';

export const SERVICE_NAME = 'aggregator';

export interface AppDeps {
  store: CanonicalStore;
  internalServiceKey: string;
}

export function buildApp(logger: FastifyBaseLogger, deps: AppDeps): FastifyInstance {
  const app = Fastify({ loggerInstance: logger });

  app.setNotFoundHandler((_request, reply) => {
    const body: ErrorEnvelope = { error: { code: 'NOT_FOUND', message: 'Route not found' } };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    request.log.error({ err }, 'unhandled error');
    const body: ErrorEnvelope = { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };
    return reply.code(500).send(body);
  });

  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  }));
  registerInternalHazardsRoute(app, deps.store, deps.internalServiceKey);

  return app;
}
