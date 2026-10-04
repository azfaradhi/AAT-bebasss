import type { FastifyInstance } from 'fastify';
import type { ClientScope } from '../../../../shared-types/src/auth';
import type { HazardEvent, HazardEventResponse, HazardType } from '../../../../shared-types/src/hazard-event';
import type { AggregatorClient } from '../clients/aggregator-client';
import { filterFields, rejectForbiddenRawView } from '../middleware/rbacFilter';

export function registerHazardsRoute(app: FastifyInstance, aggregator: AggregatorClient): void {
  app.get<{ Querystring: { view?: string; hazard_type?: HazardType } }>(
    '/hazard-events',
    { preHandler: rejectForbiddenRawView },
    async (request): Promise<HazardEventResponse> => {
      const response = await aggregator.getHazards(request.query.hazard_type);
      const scope = request.clientScope as ClientScope;
      return {
        data: response.data.map((event) => filterFields(event, scope)) as HazardEvent[],
        meta: response.meta,
      };
    },
  );
}
