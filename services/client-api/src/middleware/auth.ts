import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import type { ClientAccessTokenClaims, ClientScope } from '../../../../shared-types/src/auth';
import type { ErrorEnvelope } from '../../../../shared-types/src/envelopes';

declare module 'fastify' {
  interface FastifyRequest {
    clientScope?: ClientScope;
    clientId?: string;
  }
}

const AUDIENCE = 'bnpb-client';
const ALGORITHM = 'HS256';

function unauthorized(reply: FastifyReply, message: string): void {
  const body: ErrorEnvelope = { error: { code: 'UNAUTHORIZED', message } };
  reply.code(401).send(body);
}

// Verifies the client JWT, rejects expired/invalid with 401, attaches scope to the request.
export function createAuthMiddleware(jwtSecret: string) {
  return function requireClientAuth(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      unauthorized(reply, 'Missing or invalid Authorization header');
      return done();
    }
    const token = header.slice('Bearer '.length);

    let claims: jwt.JwtPayload | string;
    try {
      claims = jwt.verify(token, jwtSecret, { algorithms: [ALGORITHM], audience: AUDIENCE });
    } catch (err) {
      const message = err instanceof jwt.TokenExpiredError ? 'Access token has expired' : 'Invalid access token';
      unauthorized(reply, message);
      return done();
    }

    if (typeof claims === 'string' || claims.purpose !== 'access') {
      unauthorized(reply, 'Token is not an access token');
      return done();
    }

    const accessClaims = claims as ClientAccessTokenClaims;
    request.clientScope = accessClaims.scope;
    request.clientId = accessClaims.sub;
    done();
  };
}
