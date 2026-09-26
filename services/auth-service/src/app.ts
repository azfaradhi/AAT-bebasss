import Fastify, { FastifyBaseLogger, FastifyError, FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { ErrorEnvelope, HealthResponse } from '../../../shared-types/src/envelopes';
import { contextStorage } from './context';
import type { ClientRegistry } from './domain/clientRegistry';
import type { TokenService } from './domain/tokenService';
import { AppError } from './errors';
import { registerRefreshRoute } from './routes/refresh';
import { registerTokenRoute } from './routes/token';

export const SERVICE_NAME = 'auth-service';

export interface AppDeps {
  registry: ClientRegistry;
  tokens: TokenService;
}

export function buildApp(logger: FastifyBaseLogger, deps: AppDeps): FastifyInstance {
  const app = Fastify({ loggerInstance: logger });

  // Bind X-Correlation-ID once per request via AsyncLocalStorage
  app.addHook('onRequest', (request, reply, done) => {
    const inbound = request.headers['x-correlation-id'];
    const correlationId = typeof inbound === 'string' && inbound.length > 0 ? inbound : randomUUID();
    reply.header('x-correlation-id', correlationId);
    contextStorage.run({ correlationId }, done);
  });

  app.setNotFoundHandler((_request, reply) => {
    const body: ErrorEnvelope = { error: { code: 'NOT_FOUND', message: 'Route not found' } };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof AppError) {
      const body: ErrorEnvelope = { error: { code: err.code, message: err.message } };
      return reply.code(err.statusCode).send(body);
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      const body: ErrorEnvelope = { error: { code: 'BAD_REQUEST', message: err.message } };
      return reply.code(status).send(body);
    }
    request.log.error({ err }, 'unhandled error');
    const body: ErrorEnvelope = { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };
    return reply.code(500).send(body);
  });

  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  }));

  registerTokenRoute(app, deps.registry, deps.tokens);
  registerRefreshRoute(app, deps.registry, deps.tokens);

  return app;
}
