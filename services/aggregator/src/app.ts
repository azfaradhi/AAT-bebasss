import Fastify, { FastifyBaseLogger, FastifyError, FastifyInstance } from 'fastify';
import type { ErrorEnvelope, HealthResponse } from '../../../shared-types/src/envelopes';
import type { CanonicalStore } from './storage/canonical-store';
import { registerInternalHazardsRoute } from './internal-api/hazards-route';
import { bindCorrelationId } from './internal-api/correlation-id';
import { registerHttpMetrics } from './resilience/obs';

export const SERVICE_NAME = 'aggregator';

export interface AppDeps {
  store: CanonicalStore;
  internalServiceKey: string;
  readinessCheck?: () => Promise<boolean> | boolean;
  onMetricsScrape?: () => Promise<void> | void;
  // Registers extra routes (audit, analytics, ingest ops) once the storage backend is known.
  extras?: (app: FastifyInstance) => void;
}

export function buildApp(logger: FastifyBaseLogger, deps: AppDeps): FastifyInstance {
  const app = Fastify({ loggerInstance: logger });
  const instanceId = process.env.POD_NAME ?? process.env.HOSTNAME ?? 'aggregator-local';
  const version = process.env.AGGREGATOR_VERSION ?? 'v1';

  registerHttpMetrics(app, SERVICE_NAME, deps.readinessCheck);
  app.addHook('onRequest', bindCorrelationId);
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-aggregator-instance', instanceId);
    reply.header('x-aggregator-version', version);
    return payload;
  });
  if (deps.onMetricsScrape) {
    app.addHook('preHandler', async (request) => {
      if (request.url.startsWith('/metrics')) {
        await deps.onMetricsScrape?.();
      }
    });
  }

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
    status: 'ok',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  });
  app.get('/health', healthHandler);
  app.get('/healthz', healthHandler);

  registerInternalHazardsRoute(app, deps.store, deps.internalServiceKey);
  deps.extras?.(app);

  return app;
}
