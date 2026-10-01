import jwt from 'jsonwebtoken';
import type { ClientAccessTokenClaims, ClientScope } from '../../../shared-types/src/auth';
import { buildApp } from './app';

export const TEST_SECRET = 'test-client-secret';

export function signAccessToken(scope: ClientScope, overrides: Partial<ClientAccessTokenClaims> = {}, secret = TEST_SECRET): string {
  return jwt.sign(
    { scope, purpose: 'access', ...overrides },
    secret,
    { subject: `${scope}-client`, audience: 'bnpb-client', expiresIn: overrides.exp ? undefined : '60s', algorithm: 'HS256' },
  );
}

export function buildTestApp(secret = TEST_SECRET) {
  return buildApp(undefined as never, { clientJwtSecret: secret });
}
