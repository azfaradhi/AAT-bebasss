import Fastify, { FastifyBaseLogger, FastifyError, FastifyInstance } from 'fastify';
import type { ErrorEnvelope, HealthResponse } from '../../../../shared-types/src/envelopes';
import { registerHttpMetrics } from './obs/index';

export const SERVICE_NAME = 'dashboard-updater';

export function buildApp(logger: FastifyBaseLogger, isBrokerConnected: () => boolean): FastifyInstance {
  const app = Fastify({ loggerInstance: logger });

  registerHttpMetrics(app, SERVICE_NAME, isBrokerConnected);

  app.setNotFoundHandler((_request, reply) => {
    const body: ErrorEnvelope = { error: { code: 'NOT_FOUND', message: 'Route not found' } };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    request.log.error({ err }, 'unhandled error');
    const body: ErrorEnvelope = { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };
    return reply.code(500).send(body);
  });

  const healthHandler = async (): Promise<HealthResponse> => ({
    status: isBrokerConnected() ? 'ok' : 'degraded',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  });
  app.get('/health', healthHandler);
  app.get('/healthz', healthHandler);

  return app;
}
