import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { ErrorEnvelope } from '../../../../shared-types/src/envelopes';
import type { AuditProviders, AuditUnprocessedItem, ParkedMessage, ParkSource } from '../../../../shared-types/src/m2/types';
import type { StorageBackedParker } from './parker';

const SOURCES: ParkSource[] = ['BMKG', 'PVMBG', 'SATELIT', 'SENSOR_PANTAI', 'FIELD_REPORT'];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

// Lampiran A item: timestamps at second precision, only retrying|parked messages (recovered ones never appear).
export function toAuditItem(m: ParkedMessage): AuditUnprocessedItem {
  return {
    message_id: m.message_id,
    source: m.source,
    received_at: m.received_at.replace(/\.\d{3}Z$/, 'Z'),
    reason: m.reason,
    retryable: m.retryable,
    attempts: m.attempts,
    status: m.status as 'retrying' | 'parked',
  };
}

// The function Member 2's audit router registers as `AuditProviders.unprocessed`.
export function unprocessedProvider(parker: StorageBackedParker): AuditProviders['unprocessed'] {
  return async (q) => {
    const page = await parker.listUnprocessed(q);
    return { items: page.items.map(toAuditItem), next_cursor: page.next_cursor };
  };
}

export interface UnprocessedRouteOptions {
  parker: StorageBackedParker;
  auditToken: string;
  internalServiceKey: string;
  // false when the Audit router already serves /internal/audit/unprocessed through the provider.
  auditRoute?: boolean;
}

type Query = { source?: string; limit?: string; cursor?: string };

function parseQuery(request: FastifyRequest<{ Querystring: Query }>, reply: FastifyReply): { source?: ParkSource; limit: number; cursor?: string } | null {
  const { source, limit, cursor } = request.query;
  const bad = (message: string) => { reply.code(400).send({ error: { code: 'BAD_REQUEST', message } } satisfies ErrorEnvelope); return null; };
  if (source !== undefined && !SOURCES.includes(source as ParkSource)) return bad(`source must be one of ${SOURCES.join(', ')}`);
  const parsed = limit === undefined ? DEFAULT_LIMIT : Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) return bad(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  return { source: source as ParkSource | undefined, limit: parsed, cursor };
}

const unauthorized = (reply: FastifyReply, message: string) => reply.code(401).send({ error: { code: 'UNAUTHORIZED', message } } satisfies ErrorEnvelope);

// GET /internal/audit/unprocessed (audit token) and GET /internal/ops/unprocessed (internal service key, adds raw metadata).
export function registerUnprocessedRoutes(app: FastifyInstance, opts: UnprocessedRouteOptions): void {
  if (opts.auditRoute !== false) {
    app.get<{ Querystring: Query }>('/internal/audit/unprocessed', async (request, reply) => {
      if (request.headers.authorization !== `Bearer ${opts.auditToken}`) return unauthorized(reply, 'Invalid audit token');
      const q = parseQuery(request, reply);
      if (!q) return reply;
      return unprocessedProvider(opts.parker)(q);
    });
  }

  app.get<{ Querystring: Query }>('/internal/ops/unprocessed', async (request, reply) => {
    if (request.headers['x-internal-key'] !== opts.internalServiceKey) return unauthorized(reply, 'Invalid internal service key');
    const q = parseQuery(request, reply);
    if (!q) return reply;
    const page = await opts.parker.listUnprocessed(q);
    return {
      items: page.items.map((m) => ({
        ...toAuditItem(m),
        reason_code: m.reason_code, ordering_key: m.ordering_key ?? null, first_failed_at: m.first_failed_at,
        last_attempt_at: m.last_attempt_at, next_attempt_at: m.next_attempt_at,
        raw_size: m.raw_size, raw_truncated: m.raw_truncated, raw_sha256: m.raw_sha256,
      })),
      next_cursor: page.next_cursor,
    };
  });
}

export function createUnprocessedApp(opts: UnprocessedRouteOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  registerUnprocessedRoutes(app, opts);
  return app;
}
