import Fastify, { FastifyBaseLogger, FastifyError, FastifyInstance } from 'fastify';
import type { ErrorEnvelope, HealthResponse } from '../../../../shared-types/src/envelopes';

export const SERVICE_NAME = 'dashboard-updater';

export function buildApp(logger: FastifyBaseLogger, isBrokerConnected: () => boolean): FastifyInstance {
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
    // degraded = up but not attached to the broker
    status: isBrokerConnected() ? 'ok' : 'degraded',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  }));

  return app;
}
