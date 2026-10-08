import type { FastifyInstance } from 'fastify';
import type { ErrorEnvelope } from '../../../../shared-types/src/envelopes';
import type { HazardType } from '../../../../shared-types/src/hazard-event';
import type { CanonicalStore } from '../storage/canonical-store';

interface HazardsQuery {
  hazard_type?: string;
  since?: string;
  limit?: string;
}

const HAZARD_TYPES: readonly HazardType[] = ['SEISMIC', 'VOLCANIC'];

export function registerInternalHazardsRoute(app: FastifyInstance, store: CanonicalStore, internalServiceKey: string): void {
  app.get<{ Querystring: HazardsQuery }>('/internal/hazard-events', async (request, reply) => {
    if (request.headers['x-internal-key'] !== internalServiceKey) {
      const body: ErrorEnvelope = { error: { code: 'UNAUTHORIZED', message: 'Invalid internal service key' } };
      return reply.code(401).send(body);
    }

    const { hazard_type, since, limit } = request.query;
    if (hazard_type !== undefined && !HAZARD_TYPES.includes(hazard_type as HazardType)) {
      const body: ErrorEnvelope = { error: { code: 'BAD_REQUEST', message: 'hazard_type must be SEISMIC or VOLCANIC' } };
      return reply.code(400).send(body);
    }
    if (since !== undefined && Number.isNaN(Date.parse(since))) {
      const body: ErrorEnvelope = { error: { code: 'BAD_REQUEST', message: 'since must be an ISO 8601 timestamp' } };
      return reply.code(400).send(body);
    }
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      const body: ErrorEnvelope = { error: { code: 'BAD_REQUEST', message: 'limit must be a positive integer' } };
      return reply.code(400).send(body);
    }

    return store.list({
      hazardType: hazard_type as HazardType | undefined,
      since,
      limit: parsedLimit,
    });
  });
}
