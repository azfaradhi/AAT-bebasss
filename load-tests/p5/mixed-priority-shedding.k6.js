// k6 Load Test for P5-K5 (Priority Load Shedding) & P5-K6 (Game Day)
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    media_flood: {
      executor: 'constant-vus',
      vus: 40,
      duration: '30s',
      exec: 'mediaScenario',
    },
    internal_ops: {
      executor: 'constant-vus',
      vus: 8,
      duration: '30s',
      exec: 'internalScenario',
    },
    lapangan_critical: {
      executor: 'constant-vus',
      vus: 8,
      duration: '30s',
      exec: 'lapanganScenario',
    },
  },
  thresholds: {
    'http_req_failed{priority:lapangan}': ['rate==0'], // 0% failure for field officers (lapangan)
    'http_req_duration{priority:lapangan}': ['p(99)<500'],
  },
};

const CLIENT_API_URL = __ENV.CLIENT_API_URL || 'http://localhost:8080';
const MEDIA_TOKEN = __ENV.MEDIA_TOKEN || '';
const INTERNAL_TOKEN = __ENV.INTERNAL_TOKEN || '';
const LAPANGAN_TOKEN = __ENV.LAPANGAN_TOKEN || '';

export function mediaScenario() {
  const res = http.get(`${CLIENT_API_URL}/api/v1/hazards`, {
    headers: { Authorization: `Bearer ${MEDIA_TOKEN}` },
    tags: { priority: 'media' },
  });
  check(res, {
    'media is 200 or 429 shed with Retry-After': (r) =>
      r.status === 200 || (r.status === 429 && r.headers['Retry-After'] !== undefined),
  });
  sleep(0.05);
}

export function internalScenario() {
  const res = http.get(`${CLIENT_API_URL}/api/v1/hazards`, {
    headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
    tags: { priority: 'internal' },
  });
  check(res, {
    'internal is 200 or 429': (r) => r.status === 200 || r.status === 429,
  });
  sleep(0.1);
}

export function lapanganScenario() {
  const res = http.get(`${CLIENT_API_URL}/api/v1/hazards?view=raw`, {
    headers: { Authorization: `Bearer ${LAPANGAN_TOKEN}` },
    tags: { priority: 'lapangan' },
  });
  check(res, {
    'lapangan always succeeds with 200 OK': (r) => r.status === 200,
  });
  sleep(0.1);
}
