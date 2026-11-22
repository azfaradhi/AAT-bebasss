import { describe, expect, it } from 'vitest';
import { HpaController, parsePrometheusHttpRequestCount } from './hpa-controller';

describe('HpaController (BON-3 / MB2-C1)', () => {
  it('scales up immediately when utilization exceeds target + 10% tolerance and scales down only after stabilization window', () => {
    let clock = 1000;
    const hpa = new HpaController(
      {
        minReplicas: 3,
        maxReplicas: 5,
        maxCapacityPerReplica: 100,
        targetAverageUtilizationPct: 70,
        scaleDownStabilizationMs: 5000,
      },
      () => clock,
    );

    // 1. Baseline: 45 req/s per replica (45% < 70%) -> stays at minReplicas=3
    const e1 = hpa.evaluate(3, [45, 45, 45]);
    expect(e1.action).toBe('noop');
    expect(e1.desiredReplicasStabilized).toBe(3);

    // 2. Surge: 115 req/s per replica (115% vs 70% target -> ceil(3 * 115/70) = 5) -> immediate scale_up to 5
    clock += 1000;
    const e2 = hpa.evaluate(3, [115, 115, 115]);
    expect(e2.action).toBe('scale_up');
    expect(e2.desiredReplicasStabilized).toBe(5);

    // 3. Load drops to 25 req/s per replica across 5 replicas, but within 5000ms stabilization window -> holds at 5
    clock += 2000;
    const e3 = hpa.evaluate(5, [25, 25, 25, 25, 25]);
    expect(e3.desiredReplicasRaw).toBe(3);
    expect(e3.desiredReplicasStabilized).toBe(5);
    expect(e3.action).toBe('noop');

    // 4. After 5000ms stabilization window passes with low load -> scales down to 3
    clock += 4000;
    const e4 = hpa.evaluate(5, [25, 25, 25, 25, 25]);
    expect(e4.desiredReplicasStabilized).toBe(3);
    expect(e4.action).toBe('scale_down');
  });

  it('parses bnpb_http_server_request_duration_seconds_count from /metrics', () => {
    const sample = [
      '# TYPE bnpb_http_server_request_duration_seconds histogram',
      'bnpb_http_server_request_duration_seconds_count{method="GET",route="/internal/hazard-events",service="aggregator",status_class="2xx"} 142',
      'bnpb_http_server_request_duration_seconds_count{method="GET",route="/ready",service="aggregator",status_class="2xx"} 18',
    ].join('\n');
    expect(parsePrometheusHttpRequestCount(sample)).toBe(160);
  });
});
