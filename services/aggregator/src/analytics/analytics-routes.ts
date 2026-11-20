import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { StorageClient } from '../../../../shared-types/src/m2/types';
import { isoMs } from '../../../../shared-types/src/m2/ids';

export interface RegisterAnalyticsOptions {
  storage: StorageClient;
  internalServiceKey?: string;
}

export function registerAnalyticsRoutes(app: FastifyInstance, options: RegisterAnalyticsOptions): void {
  const { storage, internalServiceKey = process.env.INTERNAL_SERVICE_KEY || 'changeme-internal-key' } = options;

  // GET /internal/analytics/summary
  app.get('/internal/analytics/summary', async (request: FastifyRequest<{
    Querystring: {
      from?: string;
      to?: string;
      bucket?: 'hour' | 'day';
    };
  }>, reply: FastifyReply) => {
    // Optional internal service key check if provided in header
    const keyHeader = request.headers['x-internal-service-key'];
    if (keyHeader && keyHeader !== internalServiceKey) {
      return reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'Invalid internal service key',
        },
      });
    }

    try {
      const { from, to, bucket = 'day' } = request.query;
      if (bucket && !['hour', 'day'].includes(bucket)) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: "Invalid bucket query parameter. Expected 'hour' or 'day'",
          },
        });
      }

      const res = await storage.aggregate({
        from,
        to,
        bucket,
      });

      return reply.send({
        ...res,
        as_of: isoMs(Date.now()),
      });
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      if (error?.name === 'StorageUnavailableError') {
        return reply.status(503).send({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: error.message || 'Storage unavailable',
          },
        });
      }
      // Spec: never 500 when storage is unreachable; any aggregation failure is reported as 503 in the envelope.
      return reply.status(503).send({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: (err as Error)?.message || 'Failed to aggregate analytics',
        },
      });
    }
  });
}
