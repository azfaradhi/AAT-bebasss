import jwt from 'jsonwebtoken';
import type {
  ClientAccessTokenClaims,
  ClientRefreshTokenClaims,
  ClientScope,
  Permission,
  TokenResponse,
} from '../../../../shared-types/src/auth';
import { InvalidTokenError, TokenExpiredError } from '../errors';

const AUDIENCE = 'bnpb-client';
const ALGORITHM = 'HS256';

export function permissionsForScope(scope: ClientScope): Permission[] {
  switch (scope) {
    case 'lapangan':
      return ['field-reports:write'];
    case 'internal':
      return ['ops:read', 'ops:replay'];
    case 'media':
    default:
      return [];
  }
}

export interface TokenSubject {
  clientId: string;
  scope: ClientScope;
}

export class TokenService {
  constructor(
    private readonly secret: string,
    private readonly accessTtlSeconds: number,
    private readonly refreshTtlSeconds: number,
    private readonly clockToleranceSeconds = 0,
  ) {}

  issueTokenPair(subject: TokenSubject): TokenResponse {
    return {
      access_token: this.sign(subject, 'access', this.accessTtlSeconds),
      token_type: 'Bearer',
      expires_in: this.accessTtlSeconds,
      refresh_token: this.sign(subject, 'refresh', this.refreshTtlSeconds),
    };
  }

  verifyAccessToken(token: string): ClientAccessTokenClaims {
    const decoded = this.verify(token, 'access') as ClientAccessTokenClaims;
    return {
      ...decoded,
      permissions: decoded.permissions ?? permissionsForScope(decoded.scope),
    };
  }

  verifyRefreshToken(token: string): ClientRefreshTokenClaims {
    return this.verify(token, 'refresh') as ClientRefreshTokenClaims;
  }

  private sign(subject: TokenSubject, purpose: 'access' | 'refresh', ttlSeconds: number): string {
    const payload =
      purpose === 'access'
        ? { scope: subject.scope, permissions: permissionsForScope(subject.scope), purpose }
        : { scope: subject.scope, purpose };

    return jwt.sign(payload, this.secret, {
      algorithm: ALGORITHM,
      subject: subject.clientId,
      audience: AUDIENCE,
      expiresIn: ttlSeconds,
    });
  }

  private verify(token: string, expectedPurpose: 'access' | 'refresh'): jwt.JwtPayload {
    let decoded: string | jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, this.secret, {
        algorithms: [ALGORITHM],
        audience: AUDIENCE,
        clockTolerance: this.clockToleranceSeconds,
      });
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) throw new TokenExpiredError();
      throw new InvalidTokenError();
    }
    if (typeof decoded === 'string' || decoded.purpose !== expectedPurpose) {
      throw new InvalidTokenError(`Token is not a ${expectedPurpose} token`);
    }
    return decoded;
  }
}
