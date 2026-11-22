import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ErrorEnvelope } from '../../../../shared-types/src/envelopes';
import type { HazardSource, HazardType } from '../../../../shared-types/src/hazard-event';
import type { CanonicalStore, HazardQuery } from '../storage/canonical-store';
import { incCounter, METRICS } from '../resilience/obs';

interface HazardsQuery {
  hazard_type?: string;
  source?: string;
  since?: string;
  limit?: string;
  cursor?: string;
}

const HAZARD_TYPES: readonly HazardType[] = ['SEISMIC', 'VOLCANIC', 'WILDFIRE', 'COASTAL'];
const HAZARD_SOURCES: readonly HazardSource[] = ['BMKG', 'PVMBG', 'SATELIT', 'SENSOR_PANTAI'];

export function registerInternalHazardsRoute(app: FastifyInstance, store: CanonicalStore, internalServiceKey: string): void {
  app.get<{ Querystring: HazardsQuery }>('/internal/hazard-events', async (request, reply) => {
    if (request.headers['x-internal-key'] !== internalServiceKey) {
      const body: ErrorEnvelope = { error: { code: 'UNAUTHORIZED', message: 'Invalid internal service key' } };
      return reply.code(401).send(body);
    }

    const { hazard_type, source, since, limit, cursor } = request.query;
    if (hazard_type !== undefined && !HAZARD_TYPES.includes(hazard_type as HazardType)) {
      const body: ErrorEnvelope = { error: { code: 'BAD_REQUEST', message: 'hazard_type must be SEISMIC, VOLCANIC, WILDFIRE, or COASTAL' } };
      return reply.code(400).send(body);
    }
    if (source !== undefined && !HAZARD_SOURCES.includes(source as HazardSource)) {
      const body: ErrorEnvelope = { error: { code: 'BAD_REQUEST', message: 'source must be BMKG, PVMBG, SATELIT, or SENSOR_PANTAI' } };
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

    const query: HazardQuery = {
      hazardType: hazard_type as HazardType | undefined,
      since,
      limit: parsedLimit,
    };
    if (source !== undefined) query.source = source as HazardSource;
    if (cursor !== undefined) query.cursor = cursor;

    try {
      const res = await store.list(query);
      if (res.meta?.partial) {
        incCounter(METRICS.partialResponses, { endpoint: '/internal/hazard-events' });
      }
      const payloadStr = JSON.stringify(res);
      let digest = createHash('sha256').update(payloadStr).digest('hex');
      const rounds = Number(process.env.AGGREGATOR_DIGEST_ROUNDS ?? 1);
      for (let r = 1; r < rounds; r++) {
        digest = createHash('sha256').update(digest).digest('hex');
      }
      reply.header('etag', `"${digest.slice(0, 16)}"`);
      return res;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Storage unavailable';
      const body: ErrorEnvelope = { error: { code: 'SERVICE_UNAVAILABLE', message } };
      return reply.code(503).send(body);
    }
  });
}
