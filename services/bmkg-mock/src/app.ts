import { randomUUID } from 'node:crypto';
import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import type { ErrorEnvelope, HealthResponse } from '../../../shared-types/src/envelopes';
import type { BmkgConfig } from './config';
import type { BmkgState } from './data';

export const SERVICE_NAME = 'bmkg-mock';

export interface BmkgAppOptions {
  config: Pick<BmkgConfig, 'BMKG_API_KEY' | 'BMKG_DELAY_MIN_MS' | 'BMKG_DELAY_MAX_MS'>;
  state: BmkgState;
  logger?: boolean;
}

export function buildApp({ config, state, logger = true }: BmkgAppOptions): FastifyInstance {
  const app = Fastify({ logger: logger ? { base: { service: SERVICE_NAME } } : false });

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorEnvelope = { error: { code: 'NOT_FOUND', message: `Route ${request.method}:${request.url} not found` } };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) request.log.error({ err: error }, 'unhandled error');
    const body: ErrorEnvelope = {
      error: { code: statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST', message: error.message },
    };
    return reply.code(statusCode).send(body);
  });

  app.addHook('onRequest', async (request, reply) => {
    const inbound = request.headers['x-correlation-id'];
    const correlationId = typeof inbound === 'string' && inbound.length > 0 ? inbound : randomUUID();
    reply.header('x-correlation-id', correlationId);
    request.log.info({ correlation_id: correlationId }, 'request received');
  });

  // Simulated latency: a random delay within [min, max] on every data reques
  app.addHook('preHandler', async (request) => {
    if (request.url === '/health') return;
    const span = config.BMKG_DELAY_MAX_MS - config.BMKG_DELAY_MIN_MS;
    const delay = Math.floor(Math.random() * (span + 1)) + config.BMKG_DELAY_MIN_MS;
    await new Promise((resolve) => setTimeout(resolve, delay));
  });

  // Cross-domain rejection: a PVMBG-style Bearer token is 403, a missing or wrong X-BMKG-Key is 401
  app.addHook('preHandler', async (request, reply) => {
    if (request.url === '/health') return;

    const key = request.headers['x-bmkg-key'];
    const authHeader = request.headers.authorization;

    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const body: ErrorEnvelope = { error: { code: 'FORBIDDEN', message: 'Cross-domain credential rejected' } };
      return reply.code(403).send(body);
    }

    if (typeof key !== 'string' || key !== config.BMKG_API_KEY) {
      const body: ErrorEnvelope = { error: { code: 'UNAUTHORIZED', message: 'Invalid or missing X-BMKG-Key' } };
      return reply.code(401).send(body);
    }
  });

  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  }));

  app.get<{ Querystring: { since?: string } }>('/seismic-events', async (request) => {
    const { since } = request.query;
    const sinceMs = since ? new Date(since).getTime() : undefined;
    const data = sinceMs === undefined
      ? state.seismicEvents
      : state.seismicEvents.filter((event) => new Date(event.occurred_at).getTime() >= sinceMs);
    return { data };
  });

  // A warning belongs to its event's time window: estimated_arrival is two hours after occurred_at
  app.get<{ Querystring: { since?: string } }>('/tsunami-warnings', async (request) => {
    const { since } = request.query;
    const sinceMs = since ? new Date(since).getTime() : undefined;
    const data = sinceMs === undefined
      ? state.tsunamiWarnings
      : state.tsunamiWarnings.filter((warning) => new Date(warning.estimated_arrival).getTime() - 2 * 3_600_000 >= sinceMs);
    return { data };
  });

  return app;
}
