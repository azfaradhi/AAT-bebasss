import type { FastifyInstance } from 'fastify';
import { currentCorrelationId } from '../context';
import { AppError } from '../errors';

export interface OpsAdvisoryOptions {
  advisorBaseUrl: string;
  internalServiceKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const ABSENT = { advisory_available: false, items: [] as unknown[] };

// GET /ops/advisory: BNPB Internal only. The advisor is optional: if it is missing, slow or failing the answer is
// "no advisory", never an error, so nothing that depends on this route changes when the advisor is absent.
export function registerOpsAdvisoryRoute(app: FastifyInstance, opts: OpsAdvisoryOptions): void {
  app.get<{ Querystring: { limit?: string; hazard_id?: string } }>('/ops/advisory', async (request) => {
    if (request.clientScope !== 'internal') throw new AppError(403, 'FORBIDDEN', 'This operation requires the internal scope');
    const url = new URL('/internal/advisory', opts.advisorBaseUrl);
    for (const name of ['limit', 'hazard_id'] as const) { const v = request.query[name]; if (v !== undefined) url.searchParams.set(name, v); }
    const correlationId = currentCorrelationId();
    try {
      const res = await (opts.fetchImpl ?? fetch)(url, {
        headers: { 'x-internal-key': opts.internalServiceKey, ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
      });
      if (res.status === 400) throw new AppError(400, 'BAD_REQUEST', 'Invalid query');
      if (!res.ok) return ABSENT;
      return await res.json();
    } catch (err) {
      if (err instanceof AppError) throw err;
      return ABSENT;
    }
  });
}
