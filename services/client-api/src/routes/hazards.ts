import type { FastifyInstance } from 'fastify';
import type { ClientScope } from '../../../../shared-types/src/auth';
import type { HazardEvent, HazardEventResponse, HazardSource, HazardType } from '../../../../shared-types/src/hazard-event';
import type { AggregatorClient } from '../clients/aggregator-client';
import { AppError } from '../errors';
import { filterFields, rejectForbiddenRawView } from '../middleware/rbac-filter';

interface HazardsQuery {
  view?: string;
  hazard_type?: string;
  source?: string;
  since?: string;
  limit?: string;
  cursor?: string;
}

const HAZARD_TYPES: readonly HazardType[] = ['SEISMIC', 'VOLCANIC', 'WILDFIRE', 'COASTAL'];
const HAZARD_SOURCES: readonly HazardSource[] = ['BMKG', 'PVMBG', 'SATELIT', 'SENSOR_PANTAI'];

export function registerHazardsRoute(app: FastifyInstance, aggregator: AggregatorClient): void {
  const handler = async (request: { query: HazardsQuery; clientScope?: ClientScope }): Promise<HazardEventResponse> => {
    const { hazard_type, source, since, limit, cursor } = request.query;
    if (hazard_type !== undefined && !HAZARD_TYPES.includes(hazard_type as HazardType)) {
      throw new AppError(400, 'BAD_REQUEST', 'hazard_type must be SEISMIC, VOLCANIC, WILDFIRE, or COASTAL');
    }
    if (source !== undefined && !HAZARD_SOURCES.includes(source as HazardSource)) {
      throw new AppError(400, 'BAD_REQUEST', 'source must be BMKG, PVMBG, SATELIT, or SENSOR_PANTAI');
    }
    if (since !== undefined && Number.isNaN(Date.parse(since))) {
      throw new AppError(400, 'BAD_REQUEST', 'since must be an ISO 8601 timestamp');
    }
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      throw new AppError(400, 'BAD_REQUEST', 'limit must be a positive integer');
    }

    const response = await aggregator.getHazards({
      hazardType: hazard_type as HazardType | undefined,
      source: source as HazardSource | undefined,
      since,
      limit: parsedLimit,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    const scope = request.clientScope as ClientScope;
    return {
      data: response.data.map((event) => filterFields(event, scope)) as HazardEvent[],
      meta: response.meta,
    };
  };

  app.get<{ Querystring: HazardsQuery }>('/hazard-events', { preHandler: rejectForbiddenRawView }, handler);
  app.get<{ Querystring: HazardsQuery }>('/api/v1/hazards', { preHandler: rejectForbiddenRawView }, handler);
}
