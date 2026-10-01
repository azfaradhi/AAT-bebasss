import type { FastifyInstance } from 'fastify';
import type { HazardEvent, HazardEventResponse } from '../../../shared-types/src/hazard-event';
import type { ClientScope } from '../../../shared-types/src/auth';
import { filterFields, rejectForbiddenRawView } from './middleware/rbacFilter';

// TEMPORARY stand-in for the real GET /hazard-events route (src/routes/hazards.ts), so auth.ts and
// rbacFilter.ts can be tested before that route exists. Delete once the real route lands.
const FIXTURE_EVENTS: HazardEvent[] = [
  {
    hazard_id: 'fixture-1',
    source: 'BMKG',
    source_ref_id: 'src-1',
    hazard_type: 'SEISMIC',
    severity: 'SIAGA',
    area_name: 'Fixture Region',
    latitude: -6.2,
    longitude: 106.8,
    occurred_at: '2026-09-29T00:00:00.000Z',
    ingested_at: '2026-09-29T00:00:05.000Z',
    attributes: { magnitude: 6.6, depth_km: 12, potential_tsunami: false },
  },
];

export function registerDevStubHazardsRoute(app: FastifyInstance): void {
  app.get<{ Querystring: { view?: string; hazard_type?: string } }>(
    '/hazard-events',
    { preHandler: rejectForbiddenRawView },
    async (request) => {
      const scope = request.clientScope as ClientScope;
      const body: HazardEventResponse = {
        data: FIXTURE_EVENTS.map((e) => filterFields(e, scope)) as HazardEvent[],
        meta: { stale_since: null },
      };
      return body;
    },
  );
}
