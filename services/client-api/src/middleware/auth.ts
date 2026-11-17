import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import type { ClientAccessTokenClaims, ClientScope, Permission } from '../../../../shared-types/src/auth';
import type { ErrorEnvelope } from '../../../../shared-types/src/envelopes';
import type { ClientTokenClaims, IdentityClass } from '../../../../shared-types/src/m2/types';

declare module 'fastify' {
  interface FastifyRequest {
    clientScope?: ClientScope;
    clientId?: string;
    clientPermissions?: Permission[];
    clientClaims?: ClientTokenClaims;
  }
}

const AUDIENCE = 'bnpb-client';
const ALGORITHM = 'HS256';

function defaultPermissionsForScope(scope: ClientScope): Permission[] {
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

function unauthorized(reply: FastifyReply, message: string): void {
  const body: ErrorEnvelope = { error: { code: 'UNAUTHORIZED', message } };
  reply.code(401).send(body);
}

// Verifies the client JWT, rejects expired/invalid with 401, attaches scope & permissions to the request.
export function createAuthMiddleware(jwtSecret: string, clockToleranceSeconds = 0) {
  return function requireClientAuth(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      unauthorized(reply, 'Missing or invalid Authorization header');
      return done();
    }
    const token = header.slice('Bearer '.length);

    let claims: jwt.JwtPayload | string;
    try {
      claims = jwt.verify(token, jwtSecret, {
        algorithms: [ALGORITHM],
        audience: AUDIENCE,
        clockTolerance: clockToleranceSeconds,
      });
    } catch (err) {
      const message = err instanceof jwt.TokenExpiredError ? 'Access token has expired' : 'Invalid access token';
      unauthorized(reply, message);
      return done();
    }

    if (typeof claims === 'string' || (claims.purpose !== undefined && claims.purpose !== 'access')) {
      unauthorized(reply, 'Token is not an access token');
      return done();
    }

    const accessClaims = claims as ClientAccessTokenClaims;
    const permissions = Array.isArray(accessClaims.permissions)
      ? accessClaims.permissions
      : defaultPermissionsForScope(accessClaims.scope);

    request.clientScope = accessClaims.scope;
    request.clientId = accessClaims.sub;
    request.clientPermissions = permissions;
    request.clientClaims = {
      sub: accessClaims.sub,
      scope: accessClaims.scope,
      permissions,
      aud: String(accessClaims.aud ?? AUDIENCE),
      exp: accessClaims.exp,
      iat: accessClaims.iat,
    };
    done();
  };
}

/**
 * RBAC scope guard (P3-K5, CONTRACT-MEMBER-3.md §3).
 * Rejects authenticated requests whose scope is not in `allowedScopes` with HTTP 403 FORBIDDEN.
 */
export function requireScope(...allowedScopes: IdentityClass[]) {
  return function checkScope(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void {
    const scope = request.clientScope;
    if (!scope) {
      unauthorized(reply, 'Authentication required');
      return done();
    }
    if (!allowedScopes.includes(scope)) {
      const body: ErrorEnvelope = {
        error: {
          code: 'FORBIDDEN',
          message: `Scope '${scope}' is not permitted; required one of: ${allowedScopes.join(', ')}`,
        },
      };
      reply.code(403).send(body);
      return done();
    }
    done();
  };
}

/**
 * RBAC permission guard (P3-K5, CONTRACT-MEMBER-3.md §3).
 * Rejects authenticated requests lacking `permission` with HTTP 403 FORBIDDEN.
 */
export function requirePermission(permission: Permission) {
  return function checkPermission(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void {
    const perms = request.clientPermissions;
    if (!request.clientScope || !perms) {
      unauthorized(reply, 'Authentication required');
      return done();
    }
    if (!perms.includes(permission)) {
      const body: ErrorEnvelope = {
        error: {
          code: 'FORBIDDEN',
          message: `Missing required permission '${permission}' for scope '${request.clientScope}'`,
        },
      };
      reply.code(403).send(body);
      return done();
    }
    done();
  };
}
