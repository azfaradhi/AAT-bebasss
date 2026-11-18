import type { HazardSource, ReasonCode } from '../../../../shared-types/src/m2/types';
import { currentCorrelationId } from '../context';
import type { Logger } from '../logger';
import { SchemaIncompatibleError } from '../mapping/volcanic-schema';
import type { IngestContext } from './context';

// Maps each item on its own: a bad item is parked with its reason and the rest of the batch continues.
// A parking failure (storage down) is rethrown so the poll fails and is retried rather than losing the item.
export async function mapIsolated<I, O>(
  ingest: IngestContext,
  source: HazardSource,
  items: I[],
  mapper: (item: I) => O,
  refOf: (item: I) => string,
  logger: Logger,
): Promise<O[]> {
  const out: O[] = [];
  for (const item of items) {
    try {
      out.push(mapper(item));
      ingest.metrics.record(source, 'mapped');
    } catch (err) {
      const reason_code: ReasonCode = err instanceof SchemaIncompatibleError ? err.reason_code : 'MAPPING_ERROR';
      const detail = err instanceof SchemaIncompatibleError ? err.detail : err instanceof Error ? err.message : String(err);
      const ref = safeRef(refOf, item);
      await ingest.parker.park(
        { source, raw: Buffer.from(JSON.stringify(item) ?? 'null'), reason_code, detail, orderingKey: ref, correlationId: currentCorrelationId() },
        ingest.writeCtx(`${source}:${ref}`, currentCorrelationId()),
      );
      ingest.metrics.record(source, 'parked');
      logger.warn({ source, reason_code, ref }, 'record parked');
    }
  }
  return out;
}

function safeRef(refOf: (item: never) => string, item: unknown): string {
  try {
    return refOf(item as never) || 'unknown';
  } catch {
    return 'unknown';
  }
}
