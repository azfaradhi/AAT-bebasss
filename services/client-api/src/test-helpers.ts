import jwt from 'jsonwebtoken';
import type { ClientAccessTokenClaims, ClientScope } from '../../../shared-types/src/auth';
import { buildApp } from './app';
import type { AggregatorClient } from './clients/aggregator-client';

export const TEST_SECRET = 'test-client-secret';

export function signAccessToken(scope: ClientScope, overrides: Partial<ClientAccessTokenClaims> = {}, secret = TEST_SECRET): string {
  return jwt.sign(
    { scope, purpose: 'access', ...overrides },
    secret,
    { subject: `${scope}-client`, audience: 'bnpb-client', expiresIn: overrides.exp ? undefined : '60s', algorithm: 'HS256' },
  );
}

export function buildTestApp(secret = TEST_SECRET) {
  const aggregatorClient: AggregatorClient = {
    getHazards: async () => ({
      data: [{
        hazard_id: 'fixture-1', source: 'BMKG', source_ref_id: 'src-1', hazard_type: 'SEISMIC', severity: 'SIAGA',
        area_name: 'Fixture Region', latitude: -6.2, longitude: 106.8,
        occurred_at: '2026-10-04T00:00:00.000Z', ingested_at: '2026-10-04T00:00:05.000Z',
        attributes: { magnitude: 6.6 },
      }],
      meta: { stale_since: null },
    }),
  };
  return buildApp(undefined as never, { clientJwtSecret: secret, aggregatorClient });
}
