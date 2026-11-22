import type { FastifyInstance } from 'fastify';

export interface PlacementSource { placement(): Promise<unknown> }

// GET /internal/audit/placement: primary/replica distribution per unit and node. Under /internal/audit/, so the Audit router's bearer-token hook protects it.
export function registerPlacementRoute(app: FastifyInstance, source: PlacementSource): void {
  app.get('/internal/audit/placement', async (_request, reply) => {
    try {
      return await source.placement();
    } catch (err) {
      return reply.status(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: (err as Error)?.message || 'Placement unavailable' } });
    }
  });
}
