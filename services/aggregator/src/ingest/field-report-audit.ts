import Fastify, { type FastifyInstance } from 'fastify';
import type { ErrorEnvelope } from '../../../../shared-types/src/envelopes';
import type { FieldReportStore } from '../../../../shared-types/src/field-reports';

// GET /internal/audit/field-reports (audit token). Member 2's audit router can register `fieldReportsProvider` instead.
export function registerFieldReportAuditRoute(app: FastifyInstance, store: FieldReportStore, auditToken: string): void {
  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/internal/audit/field-reports', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${auditToken}`) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid audit token' } } satisfies ErrorEnvelope);
    }
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'limit must be an integer between 1 and 1000' } } satisfies ErrorEnvelope);
    }
    return store.audit({ limit, cursor: request.query.cursor });
  });
}

export function createFieldReportAuditApp(store: FieldReportStore, auditToken: string): FastifyInstance {
  const app = Fastify({ logger: false });
  registerFieldReportAuditRoute(app, store, auditToken);
  return app;
}
