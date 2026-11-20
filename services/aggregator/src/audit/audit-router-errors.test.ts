import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerAudit } from './audit-router';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';

const auth = { authorization: 'Bearer t' };

describe('Audit router error contract', () => {
  it('answers 429 with Retry-After once the bucket is empty and recovers as it refills', async () => {
    let t = 0;
    const app = Fastify();
    registerAudit(app, { storage: new InMemoryStorage(), auditToken: 't', rateLimitPerSec: 2, now: () => t });
    const get = () => app.inject({ method: 'GET', url: '/internal/audit/ring', headers: auth });

    expect((await get()).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(200);
    const limited = await get();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect(limited.json().error.code).toBe('RATE_LIMITED');

    t += 1000;
    expect((await get()).statusCode).toBe(200);
  });

  it('does not let unauthenticated callers drain the bucket', async () => {
    const app = Fastify();
    registerAudit(app, { storage: new InMemoryStorage(), auditToken: 't', rateLimitPerSec: 1, now: () => 0 });
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: 'GET', url: '/internal/audit/ring' })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'GET', url: '/internal/audit/ring', headers: auth })).statusCode).toBe(200);
  });

  it('maps provider failures to 503 in the envelope, never 500', async () => {
    const app = Fastify();
    const boom = async () => { throw new Error('parking store unreachable'); };
    registerAudit(app, {
      storage: new InMemoryStorage(), auditToken: 't', rateLimitPerSec: 0,
      providers: { unprocessed: boom, fieldReports: boom, criticalDeliveries: boom },
    });
    for (const url of ['unprocessed', 'field-reports', 'critical-deliveries']) {
      const res = await app.inject({ method: 'GET', url: `/internal/audit/${url}`, headers: auth });
      expect(res.statusCode, url).toBe(503);
      expect(res.json().error.code).toBe('SERVICE_UNAVAILABLE');
    }
  });

  it('maps an unexpected storage error to 503, never 500', async () => {
    const app = Fastify();
    const storage = new InMemoryStorage();
    storage.checksum = async () => { throw new TypeError('socket hang up'); };
    registerAudit(app, { storage, auditToken: 't', rateLimitPerSec: 0 });
    const res = await app.inject({ method: 'GET', url: '/internal/audit/checksum?source=BMKG', headers: auth });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('SERVICE_UNAVAILABLE');
  });
});
