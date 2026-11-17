import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { TokenService, permissionsForScope } from '../src/domain/token-service';

const SECRET = 'test-secret-at-least-32-chars-long-for-m2!!';

describe('Auth Service M2 RBAC & Clock Skew Tolerance (MB3-T06, P3-K5, R4)', () => {
  it('assigns exact contract permissions per scope (media, lapangan, internal)', () => {
    const svc = new TokenService(SECRET, 60, 900, 60);

    const mediaPair = svc.issueTokenPair({ clientId: 'media-1', scope: 'media' });
    const mediaClaims = svc.verifyAccessToken(mediaPair.access_token);
    expect(mediaClaims.scope).toBe('media');
    expect(mediaClaims.permissions).toEqual([]);
    expect(permissionsForScope('media')).toEqual([]);

    const lapPair = svc.issueTokenPair({ clientId: 'lapangan-1', scope: 'lapangan' });
    const lapClaims = svc.verifyAccessToken(lapPair.access_token);
    expect(lapClaims.scope).toBe('lapangan');
    expect(lapClaims.permissions).toEqual(['field-reports:write']);

    const intPair = svc.issueTokenPair({ clientId: 'internal-1', scope: 'internal' });
    const intClaims = svc.verifyAccessToken(intPair.access_token);
    expect(intClaims.scope).toBe('internal');
    expect(intClaims.permissions).toEqual(['ops:read', 'ops:replay']);
  });

  it('accepts tokens with +-45s clock skew when clockToleranceSeconds=60 (R4)', () => {
    const svc = new TokenService(SECRET, 60, 900, 60);

    // Token expired 45s ago (within 60s clock skew tolerance)
    const skewedToken = jwt.sign(
      { scope: 'lapangan', permissions: ['field-reports:write'], purpose: 'access' },
      SECRET,
      { algorithm: 'HS256', subject: 'lapangan-1', audience: 'bnpb-client', expiresIn: -45 },
    );

    const claims = svc.verifyAccessToken(skewedToken);
    expect(claims.sub).toBe('lapangan-1');
    expect(claims.scope).toBe('lapangan');
    expect(claims.permissions).toEqual(['field-reports:write']);

    // Token expired 90s ago (exceeds 60s tolerance -> must throw)
    const expiredToken = jwt.sign(
      { scope: 'lapangan', purpose: 'access' },
      SECRET,
      { algorithm: 'HS256', subject: 'lapangan-1', audience: 'bnpb-client', expiresIn: -90 },
    );
    expect(() => svc.verifyAccessToken(expiredToken)).toThrow();
  });
});
