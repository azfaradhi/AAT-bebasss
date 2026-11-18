import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  METRICS,
  registerHttpMetrics,
  instrumentOutbound,
  amqpInject,
  amqpExtract,
  loggerMixin,
  getActiveTraceContext,
  resetMetricsForTest,
  incCounter,
  setGauge,
} from '../src/index.js';

describe('obs-kit contract & trace propagation (MB3-T05)', () => {
  beforeEach(() => {
    resetMetricsForTest();
  });

  it('registers /metrics and /ready and records RED server + client metrics with W3C traceparent', async () => {
    const app = Fastify();
    registerHttpMetrics(app, 'client-api');

    let capturedOutboundHeaders: Record<string, string> = {};
    let capturedMixin: Record<string, string | undefined> = {};
    const mixin = loggerMixin();

    app.get('/api/v1/test', async () => {
      capturedMixin = mixin();
      await instrumentOutbound('aggregator', async (headers) => {
        capturedOutboundHeaders = headers;
        return { status: 200 };
      });
      incCounter(METRICS.shed, { identity_class: 'media' });
      setGauge(METRICS.breakerState, { target: 'sensor-pantai' }, 0);
      return { ok: true };
    });

    const incomingTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const incomingSpanId = '00f067aa0ba902b7';
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/test',
      headers: {
        traceparent: `00-${incomingTraceId}-${incomingSpanId}-01`,
        'x-correlation-id': 'corr-test-123',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-correlation-id']).toBe('corr-test-123');
    expect(capturedMixin.trace_id).toBe(incomingTraceId);
    expect(capturedMixin.correlation_id).toBe('corr-test-123');
    expect(capturedOutboundHeaders['traceparent']).toMatch(new RegExp(`^00-${incomingTraceId}-[0-9a-f]{16}-01$`));
    expect(capturedOutboundHeaders['x-correlation-id']).toBe('corr-test-123');

    const readyRes = await app.inject({ method: 'GET', url: '/ready' });
    expect(readyRes.statusCode).toBe(200);

    const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metricsRes.statusCode).toBe(200);
    expect(metricsRes.body).toContain('bnpb_http_server_request_duration_seconds_bucket');
    expect(metricsRes.body).toContain('bnpb_http_client_request_duration_seconds_bucket');
    expect(metricsRes.body).toContain('bnpb_shed_total{identity_class="media"} 1');
    expect(metricsRes.body).toContain('bnpb_breaker_state{target="sensor-pantai"} 0');
  });

  it('propagates trace_id and correlation_id across amqpInject -> amqpExtract', async () => {
    const app = Fastify();
    registerHttpMetrics(app, 'aggregator');

    let amqpHeaders: Record<string, unknown> = {};
    app.post('/publish', async () => {
      amqpHeaders = amqpInject({ custom: '1' });
      return { ok: true };
    });

    const traceId = '11112222333344445555666677778888';
    await app.inject({
      method: 'POST',
      url: '/publish',
      headers: {
        traceparent: `00-${traceId}-1234567890abcdef-01`,
        'x-correlation-id': 'corr-amqp-99',
      },
    });

    let consumerCtxTraceId = '';
    let consumerCtxCorrId = '';
    await amqpExtract(amqpHeaders, async () => {
      const ctx = getActiveTraceContext();
      consumerCtxTraceId = ctx?.traceId ?? '';
      consumerCtxCorrId = ctx?.correlationId ?? '';
    });

    expect(consumerCtxTraceId).toBe(traceId);
    expect(consumerCtxCorrId).toBe('corr-amqp-99');
  });
});
