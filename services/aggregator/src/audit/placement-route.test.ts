import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAudit } from './audit-router';
import { registerPlacementRoute } from './placement-route';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';

describe('placement route', () => {
  it('is protected by the audit token and returns what the source reports', async () => {
    const app = Fastify();
    registerAudit(app, { storage: new InMemoryStorage(), auditToken: 't', rateLimitPerSec: 0 });
    registerPlacementRoute(app, { placement: async () => ({ units: [{ unit: 'u1', node: 'n1', primary_keys: 2, replica_keys: 1 }] }) });
    expect((await app.inject({ method: 'GET', url: '/internal/audit/placement' })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/internal/audit/placement', headers: { authorization: 'Bearer t' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().units[0].primary_keys).toBe(2);
  });

  it('answers 503 in the error envelope when the source fails', async () => {
    const app = Fastify();
    registerAudit(app, { storage: new InMemoryStorage(), auditToken: 't', rateLimitPerSec: 0 });
    registerPlacementRoute(app, { placement: async () => { throw new Error('units unreachable'); } });
    const res = await app.inject({ method: 'GET', url: '/internal/audit/placement', headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('SERVICE_UNAVAILABLE');
  });
});
