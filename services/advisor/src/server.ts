import Fastify, { type FastifyInstance } from 'fastify';
import type { ErrorEnvelope } from '../../../shared-types/src/envelopes';
import { registerHttpMetrics } from '../../../shared-types/src/obs-lite';
import type { AdvisorMetrics } from './advisor';
import { LABEL } from './facts';
import type { StorageAdvisoryStore } from './store';

export interface ServerDeps { metrics: AdvisorMetrics; store: StorageAdvisoryStore; internalKey: string; isReady: () => boolean; llmEnabled: boolean }

export function buildServer(d: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const http = registerHttpMetrics(app, 'advisor');
  app.get('/health', async () => ({ status: 'ok', service: 'advisor', timestamp: new Date().toISOString() }));
  app.get('/ready', async (_r, reply) => (d.isReady() ? { status: 'ok' } : reply.code(503).send({ error: { code: 'NOT_READY', message: 'starting' } })));
  app.get('/metrics', async (_r, reply) => reply.header('content-type', 'text/plain; version=0.0.4').send(d.metrics.render() + http.render()));

  // Advisory records are labelled and separate from events; the caller (client-api) enforces the internal scope.
  app.get<{ Querystring: { limit?: string; hazard_id?: string } }>('/internal/advisory', async (request, reply) => {
    if (request.headers['x-internal-key'] !== d.internalKey) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid internal service key' } } satisfies ErrorEnvelope);
    }
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'limit must be an integer between 1 and 500' } } satisfies ErrorEnvelope);
    }
    const items = await d.store.list(limit, request.query.hazard_id);
    return { advisory_available: true, label: LABEL, llm_enabled: d.llmEnabled, breaker: d.metrics.breaker, items };
  });
  return app;
}
