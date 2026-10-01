import type { FastifyReply, FastifyRequest } from 'fastify';
import { RINGKASAN_FIELDS, type HazardEvent } from '../../../../shared-types/src/hazard-event';
import type { ClientScope } from '../../../../shared-types/src/auth';
import type { ErrorEnvelope } from '../../../../shared-types/src/envelopes';

// Field filter: media only sees Ringkasan fields, lapangan and internal see everything.
export function filterFields(event: HazardEvent, scope: ClientScope): Partial<HazardEvent> {
  if (scope === 'lapangan' || scope === 'internal') return event;
  return Object.fromEntries(RINGKASAN_FIELDS.map((f) => [f, event[f]])) as Partial<HazardEvent>;
}

interface ViewQuery {
  view?: string;
}

// Rejects an explicit view=raw request from scope:media before any downstream call.
export function rejectForbiddenRawView(
  request: FastifyRequest<{ Querystring: ViewQuery }>,
  reply: FastifyReply,
  done: (err?: Error) => void,
): void {
  const { view } = request.query;
  if (view === 'raw' && request.clientScope === 'media') {
    const body: ErrorEnvelope = {
      error: { code: 'FORBIDDEN_FIELD_ACCESS', message: 'scope "media" may not request raw fields' },
    };
    reply.code(403).send(body);
    return done();
  }
  done();
}
