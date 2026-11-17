import pino from 'pino';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CriticalAlertMessage } from '../../../../shared-types/src/m2/types';
import { buildApp } from './app';
import { CriticalDeliveryStore } from './critical-delivery-store';
import { SeenSet } from './dedup';
import { processCriticalAlert } from './handler';
import { renderPrometheusMetrics, resetMetricsForTest } from './obs/index';

const logger = pino({ level: 'silent' });

describe('Critical Alert Fast Path & Delivery Recording (MB3-T10, P5-K1)', () => {
  beforeEach(() => {
    resetMetricsForTest();
  });

  it('delivers 20 critical coastal alerts with 0 lost, deduplicates redeliveries, and achieves p95 <= 5s', async () => {
    const store = new CriticalDeliveryStore();
    const seen = new SeenSet();
    const sideEffect = vi.fn().mockResolvedValue(undefined);
    const baseTimeMs = Date.parse('2026-11-12T02:43:00.000Z');
    let currentClockMs = baseTimeMs;

    for (let i = 1; i <= 20; i++) {
      const detectedAt = new Date(baseTimeMs + i * 1000).toISOString();
      currentClockMs = baseTimeMs + i * 1000 + (40 + i * 25);

      const alert: CriticalAlertMessage = {
        message_id: `ob-hz-crit-${i}:1`,
        hazard_id: `hz-crit-${i}`,
        source: 'SENSOR_PANTAI',
        severity: 'AWAS',
        area_name: 'Pelabuhan Teluk Bayur, Sumatera Barat',
        occurred_at: detectedAt,
        detected_at: detectedAt,
        correlation_id: `corr-crit-${i}`,
      };

      const raw = Buffer.from(JSON.stringify(alert), 'utf8');
      const outcome = await processCriticalAlert(
        raw,
        { seen, sideEffect, logger, criticalDeliveries: store, clock: () => currentClockMs },
        { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
      );
      expect(outcome).toBe('ack');

      if (i % 5 === 0) {
        const redeliveryOutcome = await processCriticalAlert(
          raw,
          { seen, sideEffect, logger, criticalDeliveries: store, clock: () => currentClockMs + 50 },
        );
        expect(redeliveryOutcome).toBe('ack');
      }
    }

    const report = await store.criticalDeliveries({ limit: 50 });
    expect(report.total).toBe(20);
    expect(report.items).toHaveLength(20);
    expect(report.p95_seconds).not.toBeNull();
    expect(report.p95_seconds!).toBeLessThanOrEqual(5.0);
    expect(report.p95_seconds!).toBeLessThan(1.0);

    const app = buildApp(logger, () => true, store);
    const res = await app.inject({ method: 'GET', url: '/internal/critical-deliveries?limit=25' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(20);
    expect(body.p95_seconds).toBeLessThanOrEqual(5.0);

    const metrics = renderPrometheusMetrics();
    expect(metrics).toContain('bnpb_critical_total{outcome="delivered"} 20');
    expect(metrics).toContain('bnpb_critical_total{outcome="dedup"} 4');
    expect(metrics).toContain('bnpb_critical_e2e_seconds_count 20');
  });
});
