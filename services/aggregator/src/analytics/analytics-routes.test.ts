import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerAnalyticsRoutes } from './analytics-routes';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';
import { hazardId } from '../../../../shared-types/src/m2/ids';
import type { HazardEvent } from '../../../../shared-types/src/m2/types';

describe('Analytics Routes', () => {
  let app: ReturnType<typeof Fastify>;
  let storage: InMemoryStorage;

  beforeEach(() => {
    app = Fastify();
    storage = new InMemoryStorage();
    registerAnalyticsRoutes(app, { storage });
  });

  it('GET /internal/analytics/summary returns correct aggregated shape', async () => {
    const e1: HazardEvent = {
      hazard_id: hazardId('BMKG', 'eq-1'),
      source: 'BMKG',
      source_ref_id: 'eq-1',
      hazard_type: 'SEISMIC',
      occurred_at: '2026-11-17T01:00:00.000Z',
      area_name: 'Palu',
      coordinates: { latitude: -0.9, longitude: 119.8 },
      severity: 'WASPADA',
      description: 'Gempa Palu',
    };
    const e2: HazardEvent = {
      hazard_id: hazardId('BMKG', 'eq-2'),
      source: 'BMKG',
      source_ref_id: 'eq-2',
      hazard_type: 'SEISMIC',
      occurred_at: '2026-11-17T02:00:00.000Z',
      area_name: 'Palu',
      coordinates: { latitude: -0.9, longitude: 119.8 },
      severity: 'AWAS',
      attributes: { potential_tsunami: true },
      description: 'Tsunami Palu',
    };

    await storage.upsertEvent(e1, { fenceName: 'bmkg', fence: 1 });
    await storage.upsertEvent(e2, { fenceName: 'bmkg', fence: 1 });

    const res = await app.inject({
      method: 'GET',
      url: '/internal/analytics/summary?bucket=day',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.by_severity.WASPADA).toBe(1);
    expect(body.by_severity.AWAS).toBe(1);
    expect(body.by_type_over_time[0].gempa).toBe(1);
    expect(body.by_type_over_time[0].tsunami).toBe(1);
    expect(body.as_of).toBeDefined();
    expect(body.partial).toBe(false);
  });
});
