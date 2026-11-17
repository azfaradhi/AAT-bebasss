import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { createAuthMiddleware, requirePermission, requireScope } from '../src/middleware/auth';
import { PriorityAdmissionController, createAdmissionHooks } from '../src/middleware/admission';
import { registerHttpMetrics, resetMetricsForTest } from '../src/obs/index';
import { signAccessToken, TEST_SECRET } from '../src/test-helpers';

describe('Client API RBAC Enforcement (P3-K5, MB3-T06) & Priority Load Shedding (P5-K5, MB3-T11)', () => {
  beforeEach(() => {
    resetMetricsForTest();
  });

  it('enforces 401 on missing/invalid token, 403 FORBIDDEN on media token, and 202 on lapangan token for field-reports:write', async () => {
    const app = Fastify({ logger: false });
    const authHook = createAuthMiddleware(TEST_SECRET, 60);

    app.post(
      '/api/v1/field-reports',
      { preHandler: [authHook, requirePermission('field-reports:write')] },
      async (req, reply) => {
        return reply.status(202).send({
          report_id: 'fr-test-001',
          status: 'accepted',
          reporter: req.clientClaims?.sub,
        });
      },
    );

    app.post(
      '/internal/ops/replay',
      { preHandler: [authHook, requireScope('internal')] },
      async () => ({ ok: true }),
    );

    // 1. Missing token -> 401
    const r401 = await app.inject({ method: 'POST', url: '/api/v1/field-reports' });
    expect(r401.statusCode).toBe(401);

    // 2. Media token -> 403 FORBIDDEN
    const mediaTok = signAccessToken('media');
    const r403 = await app.inject({
      method: 'POST',
      url: '/api/v1/field-reports',
      headers: { authorization: `Bearer ${mediaTok}` },
    });
    expect(r403.statusCode).toBe(403);
    expect(r403.json().error.code).toBe('FORBIDDEN');

    // 3. Lapangan token -> 202 Accepted
    const lapTok = signAccessToken('lapangan');
    const r202 = await app.inject({
      method: 'POST',
      url: '/api/v1/field-reports',
      headers: { authorization: `Bearer ${lapTok}` },
    });
    expect(r202.statusCode).toBe(202);
    expect(r202.json().reporter).toBe('lapangan-client');

    // 4. Lapangan token on internal-only route -> 403 FORBIDDEN
    const rOps403 = await app.inject({
      method: 'POST',
      url: '/internal/ops/replay',
      headers: { authorization: `Bearer ${lapTok}` },
    });
    expect(rOps403.statusCode).toBe(403);

    // 5. Clock skew +-45s token -> accepted when clockToleranceSeconds=60 (R4)
    const skewedLapTok = jwt.sign(
      { scope: 'lapangan', permissions: ['field-reports:write'], purpose: 'access' },
      TEST_SECRET,
      { subject: 'lapangan-client', audience: 'bnpb-client', expiresIn: -45 },
    );
    const rSkew = await app.inject({
      method: 'POST',
      url: '/api/v1/field-reports',
      headers: { authorization: `Bearer ${skewedLapTok}` },
    });
    expect(rSkew.statusCode).toBe(202);
  });

  it('sheds media traffic with HTTP 429 + Retry-After under overload while admitting 100% of lapangan traffic (P5-K5)', async () => {
    const controller = new PriorityAdmissionController({
      maxInflight: 6,
      lapanganReserved: 3, // non-lapangan ceiling = 3
      mediaMaxInflight: 2,
      retryAfterSeconds: 4,
    });

    const m1 = controller.admit('media');
    const m2 = controller.admit('media');
    expect(m1.admitted).toBe(true);
    expect(m2.admitted).toBe(true);

    const m3 = controller.admit('media');
    expect(m3.admitted).toBe(false);
    if (!m3.admitted) {
      expect(m3.retryAfterSeconds).toBe(4);
      expect(m3.identity).toBe('media');
    }

    const i1 = controller.admit('internal');
    expect(i1.admitted).toBe(true);
    const i2 = controller.admit('internal');
    expect(i2.admitted).toBe(false);

    // Lapangan uses reserved capacity with 0% shedding
    const l1 = controller.admit('lapangan');
    const l2 = controller.admit('lapangan');
    const l3 = controller.admit('lapangan');
    expect(l1.admitted).toBe(true);
    expect(l2.admitted).toBe(true);
    expect(l3.admitted).toBe(true);

    if (l3.admitted) l3.release();

    const app = Fastify({ logger: false });
    registerHttpMetrics(app, 'client-api');
    const authHook = createAuthMiddleware(TEST_SECRET, 60);
    const admissionHooks = createAdmissionHooks(controller);
    app.addHook('onResponse', admissionHooks.onRelease);
    app.get('/hazard-events', { preHandler: [authHook, admissionHooks.preHandler] }, async () => ({ ok: true }));

    const mediaRes = await app.inject({
      method: 'GET',
      url: '/hazard-events',
      headers: {
        authorization: `Bearer ${signAccessToken('media')}`,
        'x-priority': 'lapangan',
      },
    });
    expect(mediaRes.statusCode).toBe(429);
    expect(mediaRes.headers['retry-after']).toBe('4');
    expect(mediaRes.json().error.code).toBe('LOAD_SHED');

    const lapRes = await app.inject({
      method: 'GET',
      url: '/hazard-events',
      headers: { authorization: `Bearer ${signAccessToken('lapangan')}` },
    });
    expect(lapRes.statusCode).toBe(200);

    const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metricsRes.body).toContain('bnpb_shed_total{identity_class="media"}');
  });
});
