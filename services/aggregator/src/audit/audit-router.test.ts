import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerAudit } from './audit-router';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';
import { hazardId } from '../../../../shared-types/src/m2/ids';
import type { HazardEvent } from '../../../../shared-types/src/m2/types';

describe('Audit Router', () => {
  let app: ReturnType<typeof Fastify>;
  let storage: InMemoryStorage;
  const auditToken = 'test-audit-token';

  beforeEach(() => {
    app = Fastify();
    storage = new InMemoryStorage();
    registerAudit(app, {
      storage,
      auditToken,
      providers: {
        unprocessed: async () => ({ items: [], next_cursor: null }),
        fieldReports: async () => ({
          accepted_total: 5,
          processed_total: 5,
          duplicates_dropped_total: 0,
          unprocessed_keys: [],
          next_cursor: null,
        }),
      },
    });
  });

  it('rejects requests without Authorization header with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/internal/audit/events',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing Authorization header',
      },
    });
  });

  it('rejects requests with invalid token with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/internal/audit/events',
      headers: {
        authorization: 'Bearer wrong-token',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'Invalid audit token',
      },
    });
  });

  it('returns events on valid token', async () => {
    const event: HazardEvent = {
      hazard_id: hazardId('BMKG', 'bmkg-001'),
      source: 'BMKG',
      source_ref_id: 'bmkg-001',
      hazard_type: 'SEISMIC',
      occurred_at: '2026-11-17T00:00:00.000Z',
      area_name: 'Palu',
      coordinates: { latitude: -0.9, longitude: 119.8 },
      severity: 'WASPADA',
      description: 'Gempa',
    };
    await storage.upsertEvent(event, { fenceName: 'bmkg', fence: 1 });

    const res = await app.inject({
      method: 'GET',
      url: '/internal/audit/events',
      headers: {
        authorization: `Bearer ${auditToken}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].hazard_id).toBe(event.hazard_id);
    expect(body.partial).toBe(false);
  });

  it('returns checksum on valid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/internal/audit/checksum?source=BMKG',
      headers: {
        authorization: `Bearer ${auditToken}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe('BMKG');
    expect(body.checksum).toBeDefined();
    expect(body.partial).toBe(false);
  });

  it('returns location and 404 for unknown location', async () => {
    const id = hazardId('BMKG', 'bmkg-999');
    const notFoundRes = await app.inject({
      method: 'GET',
      url: `/internal/audit/location?hazard_id=${id}`,
      headers: {
        authorization: `Bearer ${auditToken}`,
      },
    });
    expect(notFoundRes.statusCode).toBe(404);

    const event: HazardEvent = {
      hazard_id: id,
      source: 'BMKG',
      source_ref_id: 'bmkg-999',
      hazard_type: 'SEISMIC',
      occurred_at: '2026-11-17T00:00:00.000Z',
      area_name: 'Aceh',
      coordinates: { latitude: 5.5, longitude: 95.3 },
      severity: 'WASPADA',
      description: 'Gempa',
    };
    await storage.upsertEvent(event, { fenceName: 'bmkg', fence: 1 });

    const foundRes = await app.inject({
      method: 'GET',
      url: `/internal/audit/location?hazard_id=${id}`,
      headers: {
        authorization: `Bearer ${auditToken}`,
      },
    });
    expect(foundRes.statusCode).toBe(200);
    const locBody = foundRes.json();
    expect(locBody.hazard_id).toBe(id);
    expect(locBody.locations.length).toBeGreaterThanOrEqual(2);
  });

  it('returns field reports from provider', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/internal/audit/field-reports',
      headers: {
        authorization: `Bearer ${auditToken}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted_total).toBe(5);
  });
});
