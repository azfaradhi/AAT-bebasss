// k6 load test for P2-K6 (>=10.000 VU, >=120 s, scale 3->5->2), P2-K7 (throughput 1 vs 3 instances)
// and P2-K8 (version change during load, zero failed requests). One canonical script; the three
// criteria differ only in the environment variables below and in what scripts/demo/p2-load-drill.sh
// does to the Aggregator Deployment while this runs. Run it OUTSIDE the cluster (spec Lampiran B).
//
// Request path: k6 -> client-api (/api/v1/hazards) -> aggregator -> storage ring.
//
//   BASE_URL       client-api URL reachable from the load machine   (default http://localhost:8080)
//   AUTH_URL       auth-service URL (token endpoint /auth/token)     (default = BASE_URL)
//   CLIENT_ID / CLIENT_SECRET   an `internal` client (not shed before `lapangan`)
//   VUS            peak virtual users                                (default 10000)
//   DURATION       steady-state time at peak, e.g. 120s              (default 120s)
//   RAMP           ramp-up / ramp-down time                          (default 30s)
//   THINK_S        pause between requests per VU; 0 = saturate       (default 1)
//   STRICT=1       K8 mode: ANY non-2xx fails the run (429 is NOT forgiven)
//
// Controlled rejection = HTTP 429 with Retry-After (priority load shedding). It is counted separately
// and excluded from the error rate, as the spec allows. Everything else non-200 is an error.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const AUTH_URL = __ENV.AUTH_URL || BASE_URL;
const VUS = Number(__ENV.VUS || 10000);
const DURATION = __ENV.DURATION || '120s';
const RAMP = __ENV.RAMP || '30s';
const THINK_S = Number(__ENV.THINK_S === undefined ? 1 : __ENV.THINK_S);
const STRICT = __ENV.STRICT === '1';

const errors = new Rate('p2_error_rate');             // non-200 and not a controlled 429
const controlled = new Counter('p2_controlled_429');  // 429 + Retry-After
const non2xx = new Counter('p2_non_2xx');             // anything that is neither 200 nor controlled 429
// Status breakdown (k6 summaries do not list status codes); 0 = network error/timeout.
const byStatus = Object.fromEntries([0, 200, 401, 429, 500, 502, 503, 504].map((c) => [c, new Counter(`p2_status_${c}`)]));

// 429 must not be counted as http_req_failed by k6 itself; we classify it ourselves.
http.setResponseCallback(http.expectedStatuses(200, 429));

export const options = {
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    sustained: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: VUS },
        { duration: DURATION, target: VUS },
        { duration: RAMP, target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: STRICT
    ? { p2_non_2xx: ['count==0'], p2_controlled_429: ['count==0'] }
    : { p2_error_rate: ['rate<0.01'] },
};

function login() {
  return http.post(
    `${AUTH_URL}/auth/token`,
    JSON.stringify({ client_id: __ENV.CLIENT_ID, client_secret: __ENV.CLIENT_SECRET }),
    { headers: { 'content-type': 'application/json' }, tags: { name: 'login' } },
  );
}

export function setup() {
  const res = login();
  if (res.status !== 200) {
    throw new Error(`token request failed: HTTP ${res.status} (set CLIENT_ID / CLIENT_SECRET / AUTH_URL)`);
  }
}

// Access tokens are short-lived: each VU renews its own shortly before expiry (a single token from setup() expired mid-run and produced HTTP 401).
let cachedToken = null;
let cachedUntil = 0;
function token() {
  if (!cachedToken || Date.now() >= cachedUntil) {
    const res = login();
    if (res.status === 200) {
      cachedToken = res.json('access_token');
      cachedUntil = Date.now() + Math.max(5, Number(res.json('expires_in') || 60) - 10) * 1000;
    }
  }
  return cachedToken;
}

export default function () {
  const res = http.get(`${BASE_URL}/api/v1/hazards?limit=50`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  (byStatus[res.status] || byStatus[500]).add(1);
  if (res.status === 429 && res.headers['Retry-After'] !== undefined) {
    controlled.add(1);
    errors.add(false);
  } else if (res.status === 200) {
    errors.add(false);
  } else {
    non2xx.add(1);
    errors.add(true);
  }
  check(res, { 'status is 200 or controlled 429': (r) => r.status === 200 || r.status === 429 });
  if (THINK_S > 0) sleep(THINK_S);
}
