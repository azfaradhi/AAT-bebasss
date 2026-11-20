import Fastify, { type FastifyInstance } from 'fastify';
import { registerHttpMetrics } from '../../../shared-types/src/obs-lite';
import { PAGE } from './page';

export interface DashboardDeps {
  aggregatorBaseUrl: string;
  internalKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const err = (code: string, message: string) => ({ error: { code, message } });

// Serves the browser page and a same-origin proxy to the aggregator's analytics summary (the browser never sees the internal key).
export function buildDashboard(d: DashboardDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const http = registerHttpMetrics(app, 'analytics-dashboard');
  const doFetch = d.fetchImpl ?? fetch;

  app.get('/', async (_r, reply) => reply.header('content-type', 'text/html; charset=utf-8').send(PAGE));
  app.get('/healthz', async () => ({ status: 'ok', service: 'analytics-dashboard' }));
  app.get('/ready', async () => ({ status: 'ok' }));
  app.get('/metrics', async (_r, reply) => reply.header('content-type', 'text/plain; version=0.0.4').send(http.render()));

  app.get<{ Querystring: { from?: string; to?: string; bucket?: string } }>('/api/summary', async (request, reply) => {
    const { from, to, bucket = 'day' } = request.query;
    if (bucket !== 'hour' && bucket !== 'day') return reply.code(400).send(err('BAD_REQUEST', "bucket must be 'hour' or 'day'"));
    for (const [name, v] of [['from', from], ['to', to]] as const) {
      if (v !== undefined && Number.isNaN(Date.parse(v))) return reply.code(400).send(err('BAD_REQUEST', `${name} must be an ISO-8601 timestamp`));
    }
    const url = new URL('/internal/analytics/summary', d.aggregatorBaseUrl);
    url.searchParams.set('bucket', bucket);
    if (from) url.searchParams.set('from', from);
    if (to) url.searchParams.set('to', to);
    try {
      const res = await doFetch(url, { headers: { 'x-internal-service-key': d.internalKey }, signal: AbortSignal.timeout(d.timeoutMs ?? 5000) });
      const body: unknown = await res.json();
      if (!res.ok) return reply.code(res.status === 429 ? 429 : 503).send(err('SERVICE_UNAVAILABLE', `aggregator answered HTTP ${res.status}`));
      return reply.send(body);
    } catch (e) {
      return reply.code(503).send(err('SERVICE_UNAVAILABLE', `aggregator unreachable: ${e instanceof Error ? e.message : String(e)}`));
    }
  });
  return app;
}
