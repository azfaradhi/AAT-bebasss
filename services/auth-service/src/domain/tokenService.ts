import jwt from 'jsonwebtoken';
import type {
  ClientAccessTokenClaims,
  ClientRefreshTokenClaims,
  ClientScope,
} from '../../../../shared-types/src/auth';
import { InvalidTokenError, TokenExpiredError } from '../errors';

const AUDIENCE = 'bnpb-client';
const ALGORITHM = 'HS256';

// Response shape of POST /auth/token and /auth/refresh.
export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}

export interface TokenSubject {
  clientId: string;
  scope: ClientScope;
}

// Fully stateless: both tokens are self-verifying JWTs, so there is no token store.
// An old access token stops working through its own `exp`, not through a blocklist.
export class TokenService {
  constructor(
    private readonly secret: string,
    private readonly accessTtlSeconds: number,
    private readonly refreshTtlSeconds: number,
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
    return this.verify(token, 'access') as ClientAccessTokenClaims;
  }

  verifyRefreshToken(token: string): ClientRefreshTokenClaims {
    return this.verify(token, 'refresh') as ClientRefreshTokenClaims;
  }

  private sign(subject: TokenSubject, purpose: 'access' | 'refresh', ttlSeconds: number): string {
    return jwt.sign({ scope: subject.scope, purpose }, this.secret, {
      algorithm: ALGORITHM,
      subject: subject.clientId,
      audience: AUDIENCE,
      expiresIn: ttlSeconds,
    });
  }

  private verify(token: string, expectedPurpose: 'access' | 'refresh'): jwt.JwtPayload {
    let decoded: string | jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, this.secret, { algorithms: [ALGORITHM], audience: AUDIENCE });
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) throw new TokenExpiredError();
      throw new InvalidTokenError();
    }
    // An access token must not be usable as a refresh token, or the other way around.
    if (typeof decoded === 'string' || decoded.purpose !== expectedPurpose) {
      throw new InvalidTokenError(`Token is not a ${expectedPurpose} token`);
    }
    return decoded;
  }
}
