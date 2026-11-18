import type { StorageClient, WriteCtx } from '../../../../shared-types/src/m2/types';
import { loadIngestLimits, type IngestLimits } from './limits';
import { IngestMetrics } from './metrics';
import { StorageBackedParker } from './parker';

export interface IngestContext {
  parker: StorageBackedParker;
  limits: IngestLimits;
  metrics: IngestMetrics;
  writeCtx(idempotencyKey: string, correlationId?: string): WriteCtx;
}

export interface IngestContextOptions {
  storage: StorageClient;
  env?: NodeJS.ProcessEnv;
  // Current fence for the 'ingest' lease; a constant 1 when no coordinator is available.
  fence?: () => number;
  clock?: () => number;
}

export function createIngestContext(opts: IngestContextOptions): IngestContext {
  const limits = loadIngestLimits(opts.env ?? process.env);
  const parker = new StorageBackedParker(opts.storage, {
    maxAttempts: limits.maxAttempts,
    limits: { maxBytes: limits.maxBytes, maxDepth: limits.maxDepth },
    clock: opts.clock,
  });
  const fence = opts.fence ?? (() => 1);
  return {
    parker,
    limits,
    metrics: new IngestMetrics(),
    writeCtx: (idempotencyKey, correlationId = 'ingest') => ({ fence: fence(), idempotencyKey, correlationId, fenceName: 'ingest' }),
  };
}
