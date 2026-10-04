// Smoke/load scenario for the externally exposed Client API. Requires a valid client JWT.
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 50,
  duration: '60s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';
const token = __ENV.CLIENT_JWT;

export default function () {
  const response = http.get(`${baseUrl}/hazard-events`, {
    headers: { authorization: `Bearer ${token}` },
  });
  check(response, {
    'returns 200': (r) => r.status === 200,
    'uses standard hazard response shape': (r) => {
      try {
        return Array.isArray(r.json('data')) && r.json('meta') !== undefined;
      } catch (_) {
        return false;
      }
    },
  });
}
