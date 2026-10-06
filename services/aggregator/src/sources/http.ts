import type { Logger } from '../logger';
import { currentCorrelationId } from '../context';
import { UpstreamRequestError } from './source-client';

interface DataEnvelope<T> {
  data: T[];
}

function isDataEnvelope(value: unknown): value is DataEnvelope<unknown> {
  return typeof value === 'object' && value !== null && Array.isArray((value as { data?: unknown }).data);
}

export async function fetchData<T>(
  source: string,
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
  logger: Logger,
): Promise<T[]> {
  const started = Date.now();
  logger.info({ source, url: url.toString() }, 'upstream request started');
  try {
    const correlationId = currentCorrelationId();
    const response = await fetch(url, {
      headers: {
        ...headers,
        ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new UpstreamRequestError(source, `Upstream returned HTTP ${response.status}`, response.status);
    const body: unknown = await response.json();
    if (!isDataEnvelope(body)) throw new UpstreamRequestError(source, 'Upstream response is missing a data array');
    return body.data as T[];
  } catch (err) {
    if (err instanceof UpstreamRequestError) throw err;
    throw new UpstreamRequestError(source, err instanceof Error ? err.message : String(err));
  } finally {
    logger.info({ source, url: url.toString(), latency_ms: Date.now() - started }, 'upstream request completed');
  }
}
