import type { FastifyInstance } from 'fastify';
import { currentCorrelationId } from '../context';
import { AppError } from '../errors';

export interface OpsUnprocessedOptions {
  aggregatorBaseUrl: string;
  internalServiceKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

// GET /ops/unprocessed: BNPB Internal only (media and lapangan get 403). Forwards paging/filter params to the aggregator.
export function registerOpsUnprocessedRoute(app: FastifyInstance, opts: OpsUnprocessedOptions): void {
  app.get<{ Querystring: { source?: string; limit?: string; cursor?: string } }>('/ops/unprocessed', async (request) => {
    if (request.clientScope !== 'internal') throw new AppError(403, 'FORBIDDEN', 'This operation requires the internal scope');

    const url = new URL('/internal/ops/unprocessed', opts.aggregatorBaseUrl);
    for (const name of ['source', 'limit', 'cursor'] as const) {
      const value = request.query[name];
      if (value !== undefined) url.searchParams.set(name, value);
    }
    const correlationId = currentCorrelationId();
    let response: Response;
    try {
      response = await (opts.fetchImpl ?? fetch)(url, {
        headers: { 'x-internal-key': opts.internalServiceKey, ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
    } catch {
      throw new AppError(503, 'AGGREGATOR_UNAVAILABLE', 'Could not reach the aggregator');
    }
    if (response.status === 400) throw new AppError(400, 'BAD_REQUEST', 'Invalid query');
    if (!response.ok) throw new AppError(502, 'UNPROCESSED_FAILED', `Aggregator returned HTTP ${response.status}`);
    return response.json();
  });
}
