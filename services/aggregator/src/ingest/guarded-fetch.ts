import type { HazardSource, ReasonCode } from '../../../../shared-types/src/m2/types';
import { currentCorrelationId } from '../context';
import type { Logger } from '../logger';
import { UpstreamRequestError } from '../sources/source-client';
import type { IngestContext } from './context';
import { guardHttpBody } from './guard';

const INSTANCE = process.env.HOSTNAME ?? 'aggregator-local';

// Reads at most cap+1 bytes so an oversized body is never held in memory.
async function readCapped(response: Response, cap: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, cap + 1);
}

// Fetches a {data: [...]} envelope. A bad body is parked as a whole and the poll fails; a transport error is not parked.
export async function fetchGuarded(
  ingest: IngestContext,
  source: HazardSource,
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
  logger: Logger,
): Promise<unknown[]> {
  const started = Date.now();
  const correlationId = currentCorrelationId();
  logger.info({ source, url: url.toString() }, 'upstream request started');
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { ...headers, 'x-aggregator-instance': INSTANCE, ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new UpstreamRequestError(source, err instanceof Error ? err.message : String(err));
    }
    if (!response.ok) throw new UpstreamRequestError(source, `Upstream returned HTTP ${response.status}`, response.status);

    const raw = await readCapped(response, ingest.limits.maxBytes);
    const reject = async (reason_code: ReasonCode, detail: string): Promise<never> => {
      await ingest.parker.park({ source, raw, reason_code, detail, correlationId }, ingest.writeCtx(`${source}:${url.pathname}`, correlationId));
      ingest.metrics.record(source, 'response_rejected');
      throw new UpstreamRequestError(source, `response parked: ${reason_code.toLowerCase()}`);
    };

    const guarded = guardHttpBody(raw, response.headers.get('content-type'), {
      maxBytes: ingest.limits.maxBytes,
      maxDepth: ingest.limits.maxDepth,
    });
    if (!guarded.ok) return await reject(guarded.reason_code, guarded.detail);
    const body = guarded.json as { data?: unknown } | null;
    if (typeof body !== 'object' || body === null || !Array.isArray(body.data)) {
      return await reject('SCHEMA_INCOMPATIBLE', 'response is missing a data array');
    }
    return body.data;
  } finally {
    logger.info({ source, url: url.toString(), latency_ms: Date.now() - started }, 'upstream request completed');
  }
}
