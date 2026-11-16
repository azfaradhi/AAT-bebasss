import Fastify, { type FastifyInstance } from 'fastify';
import type { SatelliteMetrics } from './metrics';

export function buildServer(metrics: SatelliteMetrics, isReady: () => boolean, extraMetrics: () => string): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({ status: 'ok', service: 'satellite-processor', timestamp: new Date().toISOString() }));
  app.get('/ready', async (_req, reply) => (isReady()
    ? { status: 'ok' }
    : reply.code(503).send({ error: { code: 'NOT_READY', message: 'cursor not read yet' } })));
  app.get('/metrics', async (_req, reply) => reply.header('content-type', 'text/plain; version=0.0.4').send(metrics.render() + extraMetrics()));
  return app;
}
