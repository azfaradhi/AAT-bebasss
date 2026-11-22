import type { FastifyInstance } from 'fastify';
import { FencedError, StorageUnavailableError, type StorageClient } from '../../../../shared-types/src/m2/types';
import { GATEWAY_OPS, type GatewayOp } from '../../../../shared-types/src/ring/gateway-client';
import { incCounter, METRICS } from '../resilience/obs';

// POST /internal/storage/:op runs one StorageClient call for components that may not reach the storage units directly.
export function registerStorageGateway(app: FastifyInstance, storage: StorageClient, internalServiceKey: string): void {
  app.post<{ Params: { op: string }; Body: { args?: unknown[] } }>('/internal/storage/:op', async (request, reply) => {
    if (request.headers['x-internal-key'] !== internalServiceKey) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid internal service key' } });
    }
    const op = request.params.op as GatewayOp;
    if (!GATEWAY_OPS.includes(op)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: `Unknown storage operation ${request.params.op}` } });
    const args = Array.isArray(request.body?.args) ? request.body.args : [];
    try {
      const result = await (storage[op] as (...a: unknown[]) => Promise<unknown>).apply(storage, args);
      return { result: result ?? null };
    } catch (err) {
      if (err instanceof FencedError) {
        incCounter(METRICS.fencingRejections, { name: err.fenceName });
        return reply.code(409).send({ code: 'FENCED', fence_name: err.fenceName, got: err.got, current: err.current });
      }
      if (err instanceof StorageUnavailableError) return reply.code(503).send({ code: 'STORAGE_UNAVAILABLE', unavailable_units: err.unavailable_units });
      request.log.error({ err }, 'storage gateway call failed');
      return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Storage operation failed' } });
    }
  });
}
