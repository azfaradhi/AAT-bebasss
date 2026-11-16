import { createHash } from 'node:crypto';
import { hazardId, isoMs, nextIngestedAt } from '../../../../shared-types/src/m2/ids';
import type { Detection, StorageClient, WriteCtx } from '../../../../shared-types/src/m2/types';
import type { FrameSink, SatFrame, SinkContext } from '../sink';
import { FireEngine, type Counters, type Det, type LateEntry } from './engine';
import { fireToEvent } from './mapping';

interface Meta { last_applied_offset: number; last_ingested_at: string | null; max_t?: number | null; counters?: Counters }

const detDocKey = (key: string) => `det:${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
const fireDocKey = (id: string) => `fire:${id}`;

// Applies frames to the fire engine and persists state, then events, then the applied-offset marker (so replay converges).
export class FireSink implements FrameSink {
  readonly engine: FireEngine;
  private meta: Meta = { last_applied_offset: -1, last_ingested_at: null };
  private loaded = false;

  constructor(private readonly storage: StorageClient, private readonly clock: () => number = Date.now, latenessMs?: number, private readonly writeConcurrency = 32) {
    this.engine = new FireEngine(latenessMs);
  }

  get lastAppliedOffset(): number { return this.meta.last_applied_offset; }

  // Restores engine state and the applied-offset marker from `fire_state` (a new leader, or a restarted pod).
  async load(): Promise<void> {
    const dets: Det[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.storage.listDocs<Det>('fire_state', { prefix: 'det:', limit: 500, cursor });
      for (const { doc } of page.items) dets.push(doc);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    this.meta = (await this.storage.getDoc<Meta>('fire_state', 'meta')) ?? this.meta;
    const lateLog = (await this.storage.getDoc<LateEntry[]>('fire_state', 'late_log')) ?? [];
    this.engine.hydrate(dets, undefined, { max_t: this.meta.max_t ?? null, counters: this.meta.counters ?? this.engine.counters, late_log: lateLog });
    this.loaded = true;
  }

  async apply(batch: SatFrame[], ctx: SinkContext): Promise<void> {
    if (!this.loaded) await this.load();
    let endOffset = this.meta.last_applied_offset;
    for (const frame of batch) {
      if (frame.offset <= this.meta.last_applied_offset) continue; // already applied before a crash
      endOffset = frame.offset;
      if (frame.kind === 'detection') this.engine.detection(frame.offset, frame.data.detection as Detection);
      else if (frame.kind === 'update') this.engine.update(frame.offset, frame.data.key as string, frame.data.changes as Partial<Detection>);
      else if (frame.kind === 'retract') this.engine.retract(frame.offset, frame.data.key as string);
    }
    if (endOffset === this.meta.last_applied_offset) return;

    this.engine.closeExpired(endOffset);
    const changes = this.engine.takeChanges();
    const wctx = (key: string): WriteCtx => ({
      fence: ctx.fence, idempotencyKey: key, correlationId: `sat-${endOffset}`, fenceName: 'satellite',
      outbox: { mode: 'on_apply', priority: 'normal' },
    });

    // Order matters for crash safety: derived output first (fire documents, events), then the detections they were derived
    // from, then the applied-offset marker. A crash at any point replays the batch and converges: output written before the
    // detections is re-written identically (same ids, same versions), and a detection that is already persisted implies
    // that every event depending on it already is.
    // Payloads are built first (sequentially, so ids and ingested_at stay deterministic); the writes of one phase are
    // independent and run with bounded concurrency. Phases never overlap, which keeps the order above.
    const outputWrites: Array<() => Promise<unknown>> = [];
    let floor = this.meta.last_ingested_at;
    for (const [id, change] of changes.fires) {
      if (change.kind === 'upsert') {
        const doc = change.finalized ? { id, status: 'finalized', keys: [] } : { id, status: 'open', keys: [...this.engine.fires.get(id)!] };
        outputWrites.push(() => this.storage.putDoc('fire_state', fireDocKey(id), doc, wctx(`fire-${id}`)));
      } else if (change.kind === 'finalized') {
        outputWrites.push(() => this.storage.putDoc('fire_state', fireDocKey(id), { id, status: 'finalized', keys: [] }, wctx(`fire-${id}`)));
      } else {
        outputWrites.push(() => this.storage.deleteDoc('fire_state', fireDocKey(id), wctx(`fire-${id}`)));
      }
      if (change.kind === 'finalized') continue; // the published event stays as it is
      if (change.kind === 'upsert') {
        const members = change.snapshot ?? [...this.engine.fires.get(id)!].map((k) => this.engine.dets.get(k)!);
        floor = nextIngestedAt(this.clock(), floor);
        const event = { ...fireToEvent(id, members, floor), version: change.offset };
        outputWrites.push(() => this.storage.upsertEvent(event, wctx(`event-${id}-${change.offset}`)));
      } else {
        outputWrites.push(() => this.storage.tombstoneEvent(hazardIdOf(id), change.offset, wctx(`tomb-${id}-${change.offset}`), change.mergedInto ? hazardIdOf(change.mergedInto) : undefined));
      }
    }
    await runLimited(outputWrites, this.writeConcurrency);

    const inputWrites: Array<() => Promise<unknown>> = [];
    for (const key of changes.dets) {
      const det = this.engine.dets.get(key);
      inputWrites.push(() => this.storage.putDoc('fire_state', detDocKey(key), det, wctx(`det-${key}`)));
    }
    for (const key of changes.evicted) inputWrites.push(() => this.storage.deleteDoc('fire_state', detDocKey(key), wctx(`evict-${key}`)));
    if (changes.lateLogChanged) {
      const log = [...this.engine.lateLog];
      inputWrites.push(() => this.storage.putDoc('fire_state', 'late_log', log, wctx(`late-${endOffset}`)));
    }
    await runLimited(inputWrites, this.writeConcurrency);

    this.meta = { last_applied_offset: endOffset, last_ingested_at: floor ?? isoMs(this.clock()), ...this.engine.persistedState() };
    await this.storage.putDoc('fire_state', 'meta', this.meta, wctx(`meta-${endOffset}`));
  }
}

const hazardIdOf = (fireIdValue: string): string => hazardId('SATELIT', fireIdValue);

// Runs the tasks with at most `limit` in flight; rejects with the first failure after the running ones settle.
async function runLimited(tasks: Array<() => Promise<unknown>>, limit: number): Promise<void> {
  let next = 0;
  let failure: unknown;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < tasks.length) {
      const task = tasks[next++];
      try { await task(); } catch (err) { if (!failed) { failed = true; failure = err; } }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  if (failed) throw failure;
}
