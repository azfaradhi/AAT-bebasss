import type { FastifyInstance } from 'fastify';
import type { ClientScope } from '../../../../shared-types/src/auth';
import type { HazardEvent, HazardEventResponse, HazardType } from '../../../../shared-types/src/hazard-event';
import type { AggregatorClient } from '../clients/aggregator-client';
import { AppError } from '../errors';
import { filterFields, rejectForbiddenRawView } from '../middleware/rbac-filter';

interface HazardsQuery {
  view?: string;
  hazard_type?: string;
  since?: string;
  limit?: string;
}

const HAZARD_TYPES: readonly HazardType[] = ['SEISMIC', 'VOLCANIC'];

export function registerHazardsRoute(app: FastifyInstance, aggregator: AggregatorClient): void {
  app.get<{ Querystring: HazardsQuery }>(
    '/hazard-events',
    { preHandler: rejectForbiddenRawView },
    async (request): Promise<HazardEventResponse> => {
      const { hazard_type, since, limit } = request.query;
      if (hazard_type !== undefined && !HAZARD_TYPES.includes(hazard_type as HazardType)) {
        throw new AppError(400, 'BAD_REQUEST', 'hazard_type must be SEISMIC or VOLCANIC');
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
        since,
        limit: parsedLimit,
      });
      const scope = request.clientScope as ClientScope;
      return {
        data: response.data.map((event) => filterFields(event, scope)) as HazardEvent[],
        meta: response.meta,
      };
    },
  );
}
