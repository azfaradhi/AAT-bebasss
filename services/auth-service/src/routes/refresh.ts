import type { FastifyInstance } from 'fastify';
import type { ClientRegistry } from '../domain/clientRegistry';
import type { TokenService } from '../domain/tokenService';
import { InvalidTokenError } from '../errors';

interface RefreshBody {
  refresh_token: string;
}

export function registerRefreshRoute(app: FastifyInstance, registry: ClientRegistry, tokens: TokenService): void {
  app.post<{ Body: RefreshBody }>(
    '/auth/refresh',
    {
      schema: {
        body: {
          type: 'object',
          required: ['refresh_token'],
          properties: { refresh_token: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request) => {
      const claims = tokens.verifyRefreshToken(request.body.refresh_token);
      // The client must still be provisioned, with the same scope the token was minted for.
      const client = registry.findById(claims.sub);
      if (!client || client.scope !== claims.scope) {
        throw new InvalidTokenError('Token subject is no longer valid');
      }
      request.log.info({ sub: client.clientId, scope: client.scope }, 'token refreshed');
      return tokens.issueTokenPair({ clientId: client.clientId, scope: client.scope });
    },
  );
}
