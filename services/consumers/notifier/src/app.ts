import Fastify, { FastifyBaseLogger, FastifyError, FastifyInstance } from 'fastify';
import type { ErrorEnvelope, HealthResponse } from '../../../../shared-types/src/envelopes';
import type { CriticalDeliveryStore } from './critical-delivery-store';
import { registerHttpMetrics } from './obs/index';

export const SERVICE_NAME = 'notifier';

export function buildApp(
  logger: FastifyBaseLogger,
  isBrokerConnected: () => boolean,
  criticalDeliveries?: CriticalDeliveryStore,
): FastifyInstance {
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

  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    '/internal/critical-deliveries',
    async (request) => {
      if (!criticalDeliveries) {
        return { items: [], total: 0, p95_seconds: null, next_cursor: null };
      }
      const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 100)));
      return criticalDeliveries.criticalDeliveries({ limit, cursor: request.query.cursor });
    },
  );

  return app;
}
