import type { Coordinator, ReasonCode } from '../../../shared-types/src/m2/types';
import type { IngestContext } from '../../aggregator/src/ingest/context';
import type { SatelliteConfig } from './config';
import { FeedClient, FeedHttpError } from './feed-client';
import type { SatelliteMetrics } from './metrics';
import type { RawFrame } from './sse-parser';
import type { FrameKind, FrameSink, SatFrame } from './sink';

export interface LoggerLike {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ProcessorDeps {
  coordinator: Coordinator;
  ingest: IngestContext;
  sink: FrameSink;
  config: Pick<SatelliteConfig, 'SAT_CHECKPOINT_EVERY_N' | 'SAT_BATCH_SIZE' | 'SAT_FLUSH_INTERVAL_MS' | 'SAT_RECONNECT_MIN_MS' | 'SAT_RECONNECT_MAX_MS' | 'POD_NAME'>;
  client: FeedClient;
  metrics: SatelliteMetrics;
  logger: LoggerLike;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

const KINDS: FrameKind[] = ['detection', 'update', 'retract', 'heartbeat'];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

class LeadershipLost extends Error {}
class GapDetected extends Error {}

interface Entry { offset: number; frame: SatFrame | null; receivedAt: number }

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const onAbort = () => { clearTimeout(timer); resolve(); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
});

export function runSatellite(deps: ProcessorDeps): Promise<void> {
  return deps.coordinator.runAsLeader('satellite', (ctx) => leaderTerm(deps, ctx.fence, ctx.signal));
}

// One leadership term: read the cursor, stream, apply, then commit the offset by CAS (never before the sink returns).
async function leaderTerm(deps: ProcessorDeps, fence: number, signal: AbortSignal): Promise<void> {
  const { coordinator, ingest, sink, config, client, metrics, logger } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;

  const initial = await coordinator.readCursor<{ offset: number }>('satellite');
  let version = initial.version;
  let lastIngestedAt = initial.state?.last_ingested_at ?? null;
  let committed = initial.state?.position.offset ?? -1;
  let lastSeen = committed;
  let batch: Entry[] = [];
  let sinceCommit = 0;
  metrics.committedOffset = committed;
  logger.info({ committed, fence }, 'satellite leader term started');

  const commit = async (offset: number): Promise<void> => {
    if (signal.aborted) throw new LeadershipLost('leadership lost before commit');
    const ok = await coordinator.commitCursor('satellite', version, { position: { offset }, last_ingested_at: lastIngestedAt, updated_by: config.POD_NAME }, fence);
    if (!ok) throw new LeadershipLost('cursor commit rejected');
    const next = await coordinator.readCursor<{ offset: number }>('satellite');
    version = next.version;
    lastIngestedAt = next.state?.last_ingested_at ?? lastIngestedAt;
    committed = offset;
    sinceCommit = 0;
    metrics.committedOffset = offset;
  };

  let applied = committed; // highest offset the sink has applied (may be ahead of the committed cursor)
  const flush = async (force: boolean): Promise<void> => {
    if (batch.length > 0) {
      const frames = batch.flatMap((e) => (e.frame ? [e.frame] : []));
      if (signal.aborted) throw new LeadershipLost('leadership lost before apply');
      if (frames.length > 0) await sink.apply(frames, { fence, signal });
      const stored = Date.now();
      for (const e of batch) if (e.frame) metrics.observeEventToStore((stored - e.receivedAt) / 1000);
      sinceCommit += batch.length;
      applied = batch[batch.length - 1].offset;
      batch = [];
    }
    // A forced flush also commits work that an earlier time-based flush applied but did not commit.
    if ((force || sinceCommit >= config.SAT_CHECKPOINT_EVERY_N) && applied > committed) await commit(applied);
  };

  const park = async (raw: RawFrame, reason_code: ReasonCode, detail: string, offset: number | null): Promise<void> => {
    const bytes = Buffer.from(raw.oversized ? `[oversized frame, id=${raw.id}]` : `${raw.event}\n${raw.data}`);
    await ingest.parker.park(
      { source: 'SATELIT', raw: bytes, reason_code, detail, orderingKey: offset === null ? undefined : `sat-${offset}` },
      ingest.writeCtx(`sat-${offset ?? bytes.byteLength}`),
    );
    metrics.parked++;
    ingest.metrics.record('SATELIT', 'parked');
  };

  const handle = async (raw: RawFrame): Promise<void> => {
    const offset = raw.id !== null && /^\d+$/.test(raw.id) ? Number(raw.id) : null;
    if (offset === null) {
      await park(raw, 'MALFORMED_JSON', 'frame without a valid id', null); // cannot advance the cursor without an id
      return;
    }
    if (offset <= lastSeen) { metrics.duplicates++; return; }
    if (lastSeen >= 0 && offset > lastSeen + 1) {
      metrics.gaps++;
      throw new GapDetected(`expected ${lastSeen + 1}, got ${offset}`);
    }

    const { reason, detail, frame } = classify(raw, offset, deps.ingest);
    if (reason) await park(raw, reason, detail, offset);
    else metrics.frames++;
    lastSeen = offset;
    batch.push({ offset, frame, receivedAt: Date.now() });
    if (batch.length >= config.SAT_BATCH_SIZE) await flush(false);
  };

  // Frames are applied when the batch is full or has waited SAT_FLUSH_INTERVAL_MS, so a quiet live feed is not held back.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => { const run = chain.then(fn); chain = run.catch(() => undefined); return run; };
  let timerError: unknown = null;
  const flushTimer = setInterval(() => {
    if (batch.length > 0 && Date.now() - batch[0].receivedAt >= config.SAT_FLUSH_INTERVAL_MS) {
      void exclusive(() => (batch.length > 0 ? flush(false) : Promise.resolve())).catch((err) => { timerError = err; });
    }
  }, Math.max(10, Math.floor(config.SAT_FLUSH_INTERVAL_MS / 2)));

  let backoff = config.SAT_RECONNECT_MIN_MS;
  try {
  while (!signal.aborted) {
    let gotFrame = false;
    let delay = 0;
    try {
      await exclusive(() => flush(true)); // finish any batch left by a failed attempt before reading more
      for await (const raw of client.stream(lastSeen + 1, signal)) {
        if (timerError) throw timerError;
        gotFrame = true;
        await exclusive(() => handle(raw));
      }
      if (timerError) throw timerError;
      await exclusive(() => flush(true));
      delay = random() * config.SAT_RECONNECT_MIN_MS * 2; // normal server-side close: reconnect at once
    } catch (err) {
      if (signal.aborted || err instanceof LeadershipLost) break;
      const permanent = err instanceof FeedHttpError && err.permanent;
      logger[permanent ? 'error' : 'warn']({ err: err instanceof Error ? err.message : String(err), permanent }, 'satellite stream ended abnormally');
      timerError = null;
      try { await exclusive(() => flush(true)); } catch (flushErr) { if (flushErr instanceof LeadershipLost) break; }
      backoff = gotFrame ? config.SAT_RECONNECT_MIN_MS : Math.min(config.SAT_RECONNECT_MAX_MS, backoff * 2);
      delay = permanent ? config.SAT_RECONNECT_MAX_MS : random() * backoff;
      if (err instanceof GapDetected) delay = 0;
    }
    if (signal.aborted) break;
    metrics.reconnects++;
    await sleep(delay, signal);
  }
  } finally {
    clearInterval(flushTimer);
  }
  logger.info({ committed: metrics.committedOffset, fence }, 'satellite leader term ended');
}

function classify(raw: RawFrame, offset: number, ingest: IngestContext): { reason?: ReasonCode; detail: string; frame: SatFrame | null } {
  if (raw.oversized) return { reason: 'PAYLOAD_TOO_LARGE', detail: `frame ${offset} exceeds the size cap`, frame: null };
  const kind = raw.event as FrameKind;
  if (!KINDS.includes(kind)) return { reason: 'UNKNOWN_ENUM_VALUE', detail: `event kind: ${raw.event.slice(0, 40)}`, frame: null };
  const guarded = ingest.parker.guard(Buffer.from(raw.data));
  if (!guarded.ok) return { reason: guarded.reason_code, detail: guarded.detail, frame: null };
  const data = guarded.json;
  if (!isObject(data)) return { reason: 'SCHEMA_INCOMPATIBLE', detail: 'frame data is not an object', frame: null };
  const bad = shapeProblem(kind, data);
  if (bad) return { reason: 'SCHEMA_INCOMPATIBLE', detail: bad, frame: null };
  return { detail: '', frame: { offset, kind, data } };
}

function shapeProblem(kind: FrameKind, data: Record<string, unknown>): string | null {
  if (kind === 'detection') {
    const d = data.detection;
    if (!isObject(d)) return 'detection object missing';
    if (typeof d.latitude !== 'number' || typeof d.longitude !== 'number') return 'detection coordinates are not numbers';
    if (typeof d.acq_date !== 'string' || typeof d.acq_time !== 'number' || typeof d.satellite !== 'string') return 'detection time or satellite missing';
  } else if (kind === 'update') {
    if (typeof data.key !== 'string' || !isObject(data.changes)) return 'update needs key and changes';
  } else if (kind === 'retract') {
    if (typeof data.key !== 'string') return 'retract needs key';
  }
  return null;
}
