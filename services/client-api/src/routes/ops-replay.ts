import type { FastifyInstance } from 'fastify';
import { currentCorrelationId } from '../context';
import { AppError } from '../errors';

export interface OpsReplayOptions {
  aggregatorBaseUrl: string;
  internalServiceKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

// POST /ops/replay: BNPB Internal only. The aggregator owns the parked messages; this route checks the scope and forwards.
export function registerOpsReplayRoute(app: FastifyInstance, opts: OpsReplayOptions): void {
  app.post<{ Body: Record<string, unknown> | undefined }>('/ops/replay', async (request) => {
    if (request.clientScope !== 'internal') throw new AppError(403, 'FORBIDDEN', 'This operation requires the internal scope');

    const correlationId = currentCorrelationId();
    let response: Response;
    try {
      response = await (opts.fetchImpl ?? fetch)(new URL('/internal/ops/replay', opts.aggregatorBaseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-key': opts.internalServiceKey,
          ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
        },
        body: JSON.stringify(request.body ?? {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch {
      throw new AppError(503, 'AGGREGATOR_UNAVAILABLE', 'Replay could not reach the aggregator');
    }
    if (response.status === 400) throw new AppError(400, 'BAD_REQUEST', 'Invalid replay request');
    if (!response.ok) throw new AppError(502, 'REPLAY_FAILED', `Aggregator returned HTTP ${response.status}`);
    return response.json();
  });
}
