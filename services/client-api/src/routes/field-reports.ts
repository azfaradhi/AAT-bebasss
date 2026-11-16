import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ErrorEnvelope } from '../../../../shared-types/src/envelopes';
import { FieldReportStore, MAX_KEY_LENGTH, MAX_REPORT_BYTES, validateFieldReport } from '../../../../shared-types/src/field-reports';
import { StorageUnavailableError } from '../../../../shared-types/src/m2/types';
import { currentCorrelationId } from '../context';
import { AppError } from '../errors';

export interface FieldReportsRouteOptions { store: FieldReportStore }

// POST /field-reports: 202 only after the report is durably written to the ring; Lapangan scope only.
export function registerFieldReportsRoute(app: FastifyInstance, opts: FieldReportsRouteOptions): void {
  app.post<{ Body: unknown }>('/field-reports', {
    bodyLimit: MAX_REPORT_BYTES,
    errorHandler: (err, _request, reply) => {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const body: ErrorEnvelope = status === 413
        ? { error: { code: 'PAYLOAD_TOO_LARGE', message: `Report exceeds ${MAX_REPORT_BYTES} bytes` } }
        : status < 500 ? { error: { code: 'BAD_REQUEST', message: 'Malformed request body' } }
          : { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };
      return reply.code(status).send(body);
    },
  }, async (request, reply) => {
    if (request.clientScope !== 'lapangan') throw new AppError(403, 'FORBIDDEN', 'Field reports require the lapangan scope');
    const reporter = request.clientId;
    if (!reporter) throw new AppError(401, 'UNAUTHORIZED', 'Authenticated client id missing');

    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
      throw new AppError(400, 'BAD_REQUEST', `Idempotency-Key header is required (1 to ${MAX_KEY_LENGTH} characters)`);
    }
    const validation = validateFieldReport(request.body);
    if (!validation.ok) throw new AppError(400, 'BAD_REQUEST', validation.message);

    try {
      const accepted = await opts.store.accept(reporter, key, validation.value, currentCorrelationId() ?? randomUUID());
      return reply.code(202).send({ report_id: accepted.report_id, status: 'accepted', received_at: accepted.received_at });
    } catch (err) {
      if (err instanceof StorageUnavailableError) {
        reply.header('retry-after', '1');
        throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Report could not be stored durably; retry with the same Idempotency-Key');
      }
      throw err;
    }
  });
}
