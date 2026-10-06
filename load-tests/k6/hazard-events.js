// P2 scenario: a slow PVMBG must not degrade reads of already-persisted BMKG hazards.
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 50,
  duration: '60s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
  },
};

const baseUrl = __ENV.BASE_URL || 'http://localhost:8080';
const token = __ENV.CLIENT_JWT;

export default function () {
  const response = http.get(`${baseUrl}/hazard-events?hazard_type=SEISMIC`, {
    headers: { authorization: `Bearer ${token}` },
  });
  check(response, {
    'returns 200': (r) => r.status === 200,
    'returns only BMKG seismic hazards': (r) => {
      try {
        return Array.isArray(r.json('data')) && r.json('data').every((event) => event.source === 'BMKG' && event.hazard_type === 'SEISMIC');
      } catch (_) {
        return false;
      }
    },
  });
}
