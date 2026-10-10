import http from 'k6/http';
import { check } from 'k6';

const baseUrl = __ENV.BASE_URL || 'http://localhost:8080';
const token = __ENV.CLIENT_JWT;

export const options = {
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    bmkg_only: {
      executor: 'constant-vus',
      vus: 40,
      duration: '60s',
      exec: 'seismic',
      tags: { scenario_kind: 'bmkg' },
    },
    pvmbg_backed: {
      executor: 'constant-vus',
      vus: 10,
      duration: '60s',
      exec: 'volcanic',
      tags: { scenario_kind: 'pvmbg' },
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{scenario_kind:bmkg}': ['p(95)<300'],
  },
};

function get(hazardType) {
  return http.get(`${baseUrl}/hazard-events?hazard_type=${hazardType}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function onlyType(response, hazardType) {
  try {
    const data = response.json('data');
    return Array.isArray(data) && data.every((event) => event.hazard_type === hazardType);
  } catch (_) {
    return false;
  }
}

export function seismic() {
  const response = get('SEISMIC');
  check(response, {
    'seismic returns 200': (r) => r.status === 200,
    'seismic returns only SEISMIC hazards': (r) => onlyType(r, 'SEISMIC'),
  });
}

export function volcanic() {
  const response = get('VOLCANIC');
  check(response, {
    'volcanic returns 200': (r) => r.status === 200,
    'volcanic returns only VOLCANIC hazards': (r) => onlyType(r, 'VOLCANIC'),
  });
}
