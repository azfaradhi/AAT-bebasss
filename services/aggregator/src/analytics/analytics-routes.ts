import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { StorageClient } from '../../../../shared-types/src/m2/types';
import { isoMs } from '../../../../shared-types/src/m2/ids';
import { incCounter, METRICS } from '../resilience/obs';

export interface RegisterAnalyticsOptions {
  storage: StorageClient;
  internalServiceKey?: string;
  cacheTtlMs?: number;
}

export function registerAnalyticsRoutes(app: FastifyInstance, options: RegisterAnalyticsOptions): void {
  const {
    storage,
    internalServiceKey = process.env.INTERNAL_SERVICE_KEY,
    cacheTtlMs = Number(process.env.ANALYTICS_CACHE_TTL_MS ?? 0),
  } = options;
  const summaryCache = new Map<string, { at: number; body: unknown }>();

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

      const cacheKey = `${from ?? ''}|${to ?? ''}|${bucket}`;
      if (cacheTtlMs > 0) {
        const hit = summaryCache.get(cacheKey);
        if (hit && Date.now() - hit.at < cacheTtlMs) {
          return reply.send(hit.body);
        }
      }

      const res = await storage.aggregate({
        from,
        to,
        bucket,
      });
      if (res.partial) {
        incCounter(METRICS.partialResponses, { endpoint: '/internal/analytics/summary' });
      }

      const payload = {
        ...res,
        as_of: isoMs(Date.now()),
      };
      if (cacheTtlMs > 0 && !res.partial) {
        summaryCache.set(cacheKey, { at: Date.now(), body: payload });
      }
      return reply.send(payload);
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
