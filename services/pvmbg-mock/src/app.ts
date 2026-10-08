import { randomUUID } from 'node:crypto';
import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import type { ErrorEnvelope, HealthResponse } from '../../../shared-types/src/envelopes';
import type { PvmbgConfig } from './config';
import type { PvmbgState } from './data';

export const SERVICE_NAME = 'pvmbg-mock';

export interface PvmbgAppOptions {
  config: Pick<PvmbgConfig, 'PVMBG_JWT_SECRET' | 'PVMBG_DELAY_MIN_MS' | 'PVMBG_DELAY_MAX_MS'>;
  state: PvmbgState;
  logger?: boolean;
}

export function buildApp({ config, state, logger = true }: PvmbgAppOptions): FastifyInstance {
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

  const isExempt = (url: string) => url === '/health' || url.startsWith('/admin/');

  // Outage returns 503 immediately (not a hang). Otherwise a random delay within [min, max].
  app.addHook('preHandler', async (request, reply) => {
    if (isExempt(request.url)) return;
    if (state.outageActive) {
      const body: ErrorEnvelope = { error: { code: 'PVMBG_OUTAGE', message: 'Service unavailable' } };
      return reply.code(503).send(body);
    }
    const span = config.PVMBG_DELAY_MAX_MS - config.PVMBG_DELAY_MIN_MS;
    const delay = Math.floor(Math.random() * (span + 1)) + config.PVMBG_DELAY_MIN_MS;
    await new Promise((resolve) => setTimeout(resolve, delay));
  });

  // BMKG key is 403 (wrong domain). Missing or invalid PVMBG JWT is 401.
  app.addHook('preHandler', async (request, reply) => {
    if (isExempt(request.url)) return;

    if (request.headers['x-bmkg-key'] !== undefined) {
      const body: ErrorEnvelope = { error: { code: 'FORBIDDEN', message: 'Cross-domain credential rejected' } };
      return reply.code(403).send(body);
    }

    const authHeader = request.headers.authorization;
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      const body: ErrorEnvelope = { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' } };
      return reply.code(401).send(body);
    }

    try {
      jwt.verify(authHeader.slice('Bearer '.length), config.PVMBG_JWT_SECRET, { audience: 'pvmbg' });
    } catch {
      const body: ErrorEnvelope = { error: { code: 'UNAUTHORIZED', message: 'Invalid token' } };
      return reply.code(401).send(body);
    }
  });

  app.get('/health', async (): Promise<HealthResponse> => ({
    status: state.outageActive ? 'down' : 'ok',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  }));

  app.get<{ Querystring: { since?: string } }>('/volcanic-reports', async (request) => {
    const { since } = request.query;
    const sinceMs = since ? new Date(since).getTime() : undefined;
    const data = sinceMs === undefined
      ? state.reports
      : state.reports.filter((report) => new Date(report.reported_at).getTime() >= sinceMs);
    return { data };
  });

  app.post<{ Body: { enabled?: unknown } | undefined }>('/admin/schema-version', async (request, reply) => {
    if (typeof request.body?.enabled !== 'boolean') {
      const body: ErrorEnvelope = { error: { code: 'BAD_REQUEST', message: '"enabled" (boolean) is required' } };
      return reply.code(400).send(body);
    }
    state.schemaConfidenceLevelEnabled = request.body.enabled;
    return { confidence_level_enabled: state.schemaConfidenceLevelEnabled };
  });

  app.post<{ Body: { enabled?: unknown; duration_seconds?: unknown } | undefined }>('/admin/outage', async (request, reply) => {
    const body = request.body;
    if (typeof body?.enabled !== 'boolean') {
      const err: ErrorEnvelope = { error: { code: 'BAD_REQUEST', message: '"enabled" (boolean) is required' } };
      return reply.code(400).send(err);
    }
    if (body.duration_seconds !== undefined && typeof body.duration_seconds !== 'number') {
      const err: ErrorEnvelope = { error: { code: 'BAD_REQUEST', message: '"duration_seconds", if given, must be a number' } };
      return reply.code(400).send(err);
    }

    if (state.outageTimeout) {
      clearTimeout(state.outageTimeout);
      state.outageTimeout = null;
    }
    state.outageActive = body.enabled;

    const durationSeconds = body.enabled && typeof body.duration_seconds === 'number' ? body.duration_seconds : 0;
    if (durationSeconds > 0) {
      state.outageTimeout = setTimeout(() => {
        state.outageActive = false;
        state.outageTimeout = null;
      }, durationSeconds * 1000);
      state.outageTimeout.unref();
    }

    return {
      outage_active: state.outageActive,
      until: durationSeconds > 0 ? new Date(Date.now() + durationSeconds * 1000).toISOString() : null,
    };
  });

  return app;
}
