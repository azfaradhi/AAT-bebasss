import type { FastifyInstance } from 'fastify';
import type { HazardType } from '../../../../shared-types/src/hazard-event';
import type { CanonicalStore } from '../storage/canonical-store';

export function registerInternalHazardsRoute(app: FastifyInstance, store: CanonicalStore, internalServiceKey: string): void {
  app.get<{ Querystring: { hazard_type?: HazardType } }>('/internal/hazard-events', async (request, reply) => {
    if (request.headers['x-internal-service-key'] !== internalServiceKey) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid internal service key' } });
    }
    return store.list({ hazardType: request.query.hazard_type });
  });
}
