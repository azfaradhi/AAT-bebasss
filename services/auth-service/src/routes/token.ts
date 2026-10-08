import type { FastifyInstance } from 'fastify';
import type { ClientRegistry } from '../domain/client-registry';
import type { TokenService } from '../domain/token-service';
import { InvalidCredentialsError } from '../errors';

interface TokenBody {
  client_id: string;
  client_secret: string;
}

export function registerTokenRoute(app: FastifyInstance, registry: ClientRegistry, tokens: TokenService): void {
  app.post<{ Body: TokenBody }>(
    '/auth/token',
    {
      schema: {
        body: {
          type: 'object',
          required: ['client_id', 'client_secret'],
          properties: { client_id: { type: 'string', minLength: 1 }, client_secret: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request) => {
      const client = registry.authenticate(request.body.client_id, request.body.client_secret);
      if (!client) {
        request.log.warn({ client_id: request.body.client_id }, 'token request rejected');
        throw new InvalidCredentialsError();
      }
      request.log.info({ sub: client.clientId, scope: client.scope }, 'token issued');
      return tokens.issueTokenPair({ clientId: client.clientId, scope: client.scope });
    },
  );
}
