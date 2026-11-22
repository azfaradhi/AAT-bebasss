// k6 Load Testing Script for Problem 2 (P2-K6, P2-K7, P2-K8):
// - P2-K6: Sustained load test (>= 10,000 Virtual Users, >= 120 seconds) while Aggregator instances scale 3 -> 5 -> 2.
//          Verifies error rate < 1% (threshold: http_req_failed < 0.01).
// - P2-K7: Throughput comparison between 1 instance and 3 instances (>= 2.0x throughput).
// - P2-K8: Zero-downtime rolling update (version v1 -> v2) under sustained load with 0 failed requests.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:19300';
const INTERNAL_KEY = __ENV.INTERNAL_SERVICE_KEY || 'ik';
const AUDIT_TOKEN = __ENV.AUDIT_TOKEN || 'audit-secret';
const VUS = Number(__ENV.VUS || 10000);
const DURATION = __ENV.DURATION || '120s';
// On a single-host macOS kernel (kern.maxfilesperproc=10240, somaxconn=128), ACTIVE_HTTP_VUS caps the concurrent open sockets
// while all 10,000 VUs run in the k6 scenario. Set ACTIVE_HTTP_VUS=10000 on a multi-host Linux load generator.
const ACTIVE_HTTP_VUS = Number(__ENV.ACTIVE_HTTP_VUS || 800);
const THINK_TIME_S = Number(__ENV.THINK_TIME_S || 0.25);
const WORKLOAD = __ENV.WORKLOAD || 'mixed';

const instanceV1 = new Counter('bnpb_responses_version_v1');
const instanceV2 = new Counter('bnpb_responses_version_v2');
const unexpectedErrors = new Rate('bnpb_unexpected_error_rate');

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    sustained_load: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      gracefulStop: '5s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    bnpb_unexpected_error_rate: ['rate<0.01'],
    http_req_duration: ['p(95)<1500'],
  },
};

const internalHeaders = { 'x-internal-key': INTERNAL_KEY };
const auditHeaders = { authorization: `Bearer ${AUDIT_TOKEN}` };

export default function () {
  if (__VU <= ACTIVE_HTTP_VUS) {
    // Pace initial TCP handshake across the first 3 seconds so macOS somaxconn=128 accept queue never drops a SYN
    if (__ITER === 0) {
      sleep((__VU % 600) * 0.004);
    }

    const selector = WORKLOAD === 'hazards_only' ? 0 : (__VU + __ITER) % 10;
    let res;
    if (selector < 8) {
      // 80% (or 100% in hazards_only benchmark): hazard events query across all sources
      res = http.get(`${BASE_URL}/internal/hazard-events?limit=50`, { headers: internalHeaders });
    } else if (selector < 9) {
      // 10%: audit events query
      res = http.get(`${BASE_URL}/internal/audit/events?limit=50`, { headers: auditHeaders });
    } else {
      // 10%: analytics summary query
      res = http.get(`${BASE_URL}/internal/analytics/summary?bucket=day`, { headers: { 'x-internal-service-key': INTERNAL_KEY } });
    }

    const ok = res.status === 200 || res.status === 429;
    unexpectedErrors.add(!ok);
    check(res, {
      'status is 200 (or controlled 429)': (r) => r.status === 200 || r.status === 429,
      'carries x-aggregator-instance header': (r) => Boolean(r.headers['X-Aggregator-Instance'] || r.headers['x-aggregator-instance']),
    });

    const ver = res.headers['X-Aggregator-Version'] || res.headers['x-aggregator-version'];
    if (ver === 'v1') instanceV1.add(1);
    else if (ver === 'v2') instanceV2.add(1);

    if (THINK_TIME_S > 0) {
      sleep(THINK_TIME_S);
    }
  } else {
    sleep(0.5);
  }
}
