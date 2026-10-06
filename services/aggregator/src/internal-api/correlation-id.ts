import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { contextStorage } from '../context';

export function bindCorrelationId(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void {
  const inbound = request.headers['x-correlation-id'];
  const correlationId = typeof inbound === 'string' && inbound.length > 0 ? inbound : randomUUID();
  reply.header('x-correlation-id', correlationId);
  contextStorage.run({ correlationId }, done);
}
