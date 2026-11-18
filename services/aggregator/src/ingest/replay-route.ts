import Fastify, { type FastifyInstance } from 'fastify';
import type { ErrorEnvelope } from '../../../../shared-types/src/envelopes';
import type { ParkSource, ReasonCode } from '../../../../shared-types/src/m2/types';
import { replayParked, type ReplayDeps } from './replay';

interface ReplayBody { reason_code?: unknown; source?: unknown; include_retryable?: unknown }

const SOURCES: ParkSource[] = ['BMKG', 'PVMBG', 'SATELIT', 'SENSOR_PANTAI', 'FIELD_REPORT'];

// Internal replay endpoint (called by client-api after its own scope check). Guarded by the internal service key.
export function registerReplayRoute(app: FastifyInstance, deps: ReplayDeps, internalServiceKey: string): void {
  app.post<{ Body: ReplayBody | undefined }>('/internal/ops/replay', async (request, reply) => {
    if (request.headers['x-internal-key'] !== internalServiceKey) {
      const body: ErrorEnvelope = { error: { code: 'UNAUTHORIZED', message: 'Invalid internal service key' } };
      return reply.code(401).send(body);
    }
    const { reason_code, source, include_retryable } = request.body ?? {};
    const bad = (message: string) => reply.code(400).send({ error: { code: 'BAD_REQUEST', message } } satisfies ErrorEnvelope);
    if (reason_code !== undefined && typeof reason_code !== 'string') return bad('reason_code must be a string');
    if (source !== undefined && !SOURCES.includes(source as ParkSource)) return bad(`source must be one of ${SOURCES.join(', ')}`);
    if (include_retryable !== undefined && typeof include_retryable !== 'boolean') return bad('include_retryable must be a boolean');

    const report = await replayParked(deps, {
      reason_code: reason_code as ReasonCode | undefined,
      source: source as ParkSource | undefined,
      includeRetryable: include_retryable as boolean | undefined,
    });
    request.log.info({ ...report }, 'replay finished');
    return report;
  });
}

// Standalone app exposing only the replay route (used by demos and tests).
export function createReplayApp(deps: ReplayDeps, internalServiceKey: string): FastifyInstance {
  const app = Fastify({ logger: false });
  registerReplayRoute(app, deps, internalServiceKey);
  return app;
}
