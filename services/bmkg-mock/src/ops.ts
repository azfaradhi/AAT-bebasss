import type { FastifyInstance } from 'fastify';
import type { ErrorEnvelope } from '../../../shared-types/src/envelopes';
import { registerHttpMetrics } from '../../../shared-types/src/obs-lite';

export interface RequestLogEntry {
  ts: string;
  method: string;
  path: string;
  status: number;
  caller_instance: string | null;
  correlation_id: string;
  duration_ms: number;
}

const MAX_ENTRIES = 5000;
const UNLOGGED = new Set(['/health', '/ready', '/metrics', '/admin/request-log']);

export function registerOps(app: FastifyInstance, serviceName: string): void {
  const entries: RequestLogEntry[] = [];
  const counts = new Map<string, number>();
  const http = registerHttpMetrics(app, serviceName);

  app.addHook('onResponse', async (request, reply) => {
    const path = request.url.split('?')[0];
    const key = `${request.method}|${path}|${reply.statusCode}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (UNLOGGED.has(path)) return;

    const caller = request.headers['x-aggregator-instance'];
    const entry: RequestLogEntry = {
      ts: new Date().toISOString(),
      method: request.method,
      path,
      status: reply.statusCode,
      caller_instance: typeof caller === 'string' && caller.length > 0 ? caller : null,
      correlation_id: String(reply.getHeader('x-correlation-id') ?? ''),
      duration_ms: Math.round(reply.elapsedTime),
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    request.log.info({ request_log: entry }, 'request logged');
  });

  app.get<{ Querystring: { since?: string } }>('/admin/request-log', async (request, reply) => {
    const { since } = request.query;
    const sinceMs = since === undefined ? undefined : new Date(since).getTime();
    if (sinceMs !== undefined && Number.isNaN(sinceMs)) {
      const body: ErrorEnvelope = { error: { code: 'BAD_REQUEST', message: '"since" must be an ISO timestamp' } };
      return reply.code(400).send(body);
    }
    const data = sinceMs === undefined ? entries : entries.filter((e) => new Date(e.ts).getTime() >= sinceMs);
    return { data };
  });

  app.get('/ready', async () => ({ status: 'ok', service: serviceName, timestamp: new Date().toISOString() }));

  app.get('/metrics', async (_request, reply) => {
    const lines = [`# TYPE mock_http_requests_total counter`];
    for (const [key, value] of counts) {
      const [method, path, status] = key.split('|');
      lines.push(`mock_http_requests_total{service="${serviceName}",method="${method}",path="${path}",status="${status}"} ${value}`);
    }
    return reply.header('content-type', 'text/plain; version=0.0.4').send(`${lines.join('\n')}\n${http.render()}`);
  });
}
