import http from 'k6/http';
import { check } from 'k6';

const baseUrl = __ENV.BASE_URL || 'http://localhost:8080';
const token = __ENV.CLIENT_JWT;
const requestOptions = { headers: { authorization: `Bearer ${token}` } };

export const options = {
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    bmkg_only: {
      executor: 'constant-vus',
      exec: 'requestBmkgOnly',
      vus: 50,
      duration: '60s',
      tags: { workload: 'bmkg_only' },
    },
    volcanic: {
      executor: 'constant-vus',
      exec: 'requestVolcanic',
      vus: 10,
      duration: '60s',
      tags: { workload: 'volcanic' },
    },
  },
  thresholds: {
    'http_req_failed{workload:bmkg_only}': ['rate<0.01'],
    'http_req_duration{workload:bmkg_only}': ['p(95)<300'],
  },
};

export function requestBmkgOnly() {
  const response = http.get(`${baseUrl}/hazard-events?hazard_type=SEISMIC`, requestOptions);
  check(response, {
    'BMKG-only returns 200': (r) => r.status === 200,
    'BMKG-only contains only seismic data': (r) => r.json('data').every((event) => event.source === 'BMKG' && event.hazard_type === 'SEISMIC'),
  });
}

export function requestVolcanic() {
  const response = http.get(`${baseUrl}/hazard-events?hazard_type=VOLCANIC`, requestOptions);
  check(response, { 'volcanic request returns 200': (r) => r.status === 200 });
}
