/**
 * Priority Admission Control & Load Shedding (P5-K5, MB3-T11)
 * Keyed strictly on authenticated JWT identity class (`lapangan` > `internal` > `media`),
 * NEVER on client-supplied headers.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AdmissionController, AdmissionDecision, IdentityClass } from '../../../../shared-types/src/m2/types';
import type { ErrorEnvelope } from '../../../../shared-types/src/envelopes';
import { METRICS, incCounter } from '../obs/index';

export interface AdmissionOptions {
  maxInflight: number;
  lapanganReserved: number;
  mediaMaxInflight: number;
  retryAfterSeconds: number;
}

export class PriorityAdmissionController implements AdmissionController {
  private totalInflight = 0;
  private readonly byIdentity: Record<IdentityClass, number> = {
    lapangan: 0,
    internal: 0,
    media: 0,
  };

  constructor(private readonly opts: AdmissionOptions) {}

  admit(identity: IdentityClass, _correlationId?: string): AdmissionDecision {
    const { maxInflight, lapanganReserved, mediaMaxInflight, retryAfterSeconds } = this.opts;
    const nonLapanganCeiling = Math.max(1, maxInflight - lapanganReserved);

    if (identity === 'media') {
      if (this.totalInflight >= nonLapanganCeiling || this.byIdentity.media >= mediaMaxInflight) {
        incCounter(METRICS.shed, { identity_class: 'media' });
        return { admitted: false, retryAfterSeconds, identity: 'media' };
      }
    } else if (identity === 'internal') {
      if (this.totalInflight >= nonLapanganCeiling) {
        incCounter(METRICS.shed, { identity_class: 'internal' });
        return { admitted: false, retryAfterSeconds, identity: 'internal' };
      }
    } else {
      if (this.totalInflight >= maxInflight) {
        incCounter(METRICS.shed, { identity_class: 'lapangan' });
        return { admitted: false, retryAfterSeconds, identity: 'lapangan' };
      }
    }

    this.totalInflight += 1;
    this.byIdentity[identity] += 1;
    let released = false;

    return {
      admitted: true,
      release: () => {
        if (released) return;
        released = true;
        this.totalInflight = Math.max(0, this.totalInflight - 1);
        this.byIdentity[identity] = Math.max(0, this.byIdentity[identity] - 1);
      },
    };
  }

  stats(): { totalInflight: number; byIdentity: Record<IdentityClass, number> } {
    return {
      totalInflight: this.totalInflight,
      byIdentity: { ...this.byIdentity },
    };
  }
}

export function createAdmissionHooks(controller: PriorityAdmissionController) {
  const preHandler = (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void => {
    const identity: IdentityClass = request.clientScope ?? 'media';
    const decision = controller.admit(identity, request.headers['x-correlation-id'] as string | undefined);
    if (!decision.admitted) {
      reply.header('Retry-After', String(decision.retryAfterSeconds));
      const body: ErrorEnvelope = {
        error: {
          code: 'LOAD_SHED',
          message: `Request shed for priority class '${identity}'; retry after ${decision.retryAfterSeconds}s`,
        },
      };
      reply.code(429).send(body);
      return done();
    }
    (request as unknown as Record<string, unknown>)['__admissionRelease'] = decision.release;
    done();
  };

  const onRelease = async (request: FastifyRequest): Promise<void> => {
    const rel = (request as unknown as Record<string, unknown>)['__admissionRelease'] as (() => void) | undefined;
    if (rel) {
      rel();
      (request as unknown as Record<string, unknown>)['__admissionRelease'] = undefined;
    }
  };

  return { preHandler, onRelease };
}
