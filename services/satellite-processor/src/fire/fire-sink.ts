import { createHash } from 'node:crypto';
import { hazardId, isoMs, nextIngestedAt } from '../../../../shared-types/src/m2/ids';
import type { Detection, StorageClient, WriteCtx } from '../../../../shared-types/src/m2/types';
import type { FrameSink, SatFrame, SinkContext } from '../sink';
import { FireEngine, type Det } from './engine';
import { fireToEvent } from './mapping';

interface Meta { last_applied_offset: number; last_ingested_at: string | null }
interface FireDoc { id: string; keys: string[] }

const detDocKey = (key: string) => `det:${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
const fireDocKey = (id: string) => `fire:${id}`;

// Applies frames to the fire engine and persists state, then events, then the applied-offset marker (so replay converges).
export class FireSink implements FrameSink {
  readonly engine = new FireEngine();
  private meta: Meta = { last_applied_offset: -1, last_ingested_at: null };
  private loaded = false;

  constructor(private readonly storage: StorageClient, private readonly clock: () => number = Date.now) {}

  get lastAppliedOffset(): number { return this.meta.last_applied_offset; }

  // Restores engine state and the applied-offset marker from `fire_state` (a new leader, or a restarted pod).
  async load(): Promise<void> {
    const dets: Det[] = [];
    const fires: FireDoc[] = [];
    for (const [prefix, sink] of [['det:', dets], ['fire:', fires]] as const) {
      let cursor: string | undefined;
      do {
        const page = await this.storage.listDocs<Det & FireDoc>('fire_state', { prefix, limit: 500, cursor });
        for (const { doc } of page.items) (sink as unknown[]).push(doc);
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
    }
    this.engine.hydrate(dets, fires);
    this.meta = (await this.storage.getDoc<Meta>('fire_state', 'meta')) ?? this.meta;
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

    const changes = this.engine.takeChanges();
    const wctx = (key: string): WriteCtx => ({
      fence: ctx.fence, idempotencyKey: key, correlationId: `sat-${endOffset}`, fenceName: 'satellite',
      outbox: { mode: 'on_apply', priority: 'normal' },
    });

    for (const key of changes.dets) await this.storage.putDoc('fire_state', detDocKey(key), this.engine.dets.get(key), wctx(`det-${key}`));
    for (const [id, change] of changes.fires) {
      if (change.kind === 'upsert') await this.storage.putDoc('fire_state', fireDocKey(id), { id, keys: [...this.engine.fires.get(id)!] }, wctx(`fire-${id}`));
      else await this.storage.deleteDoc('fire_state', fireDocKey(id), wctx(`fire-${id}`));
    }

    let floor = this.meta.last_ingested_at;
    for (const [id, change] of changes.fires) {
      if (change.kind === 'upsert') {
        const members = [...this.engine.fires.get(id)!].map((k) => this.engine.dets.get(k)!);
        floor = nextIngestedAt(this.clock(), floor);
        await this.storage.upsertEvent({ ...fireToEvent(id, members, floor), version: change.offset }, wctx(`event-${id}-${change.offset}`));
      } else {
        await this.storage.tombstoneEvent(hazardIdOf(id), change.offset, wctx(`tomb-${id}-${change.offset}`), change.mergedInto ? hazardIdOf(change.mergedInto) : undefined);
      }
    }

    this.meta = { last_applied_offset: endOffset, last_ingested_at: floor ?? isoMs(this.clock()) };
    await this.storage.putDoc('fire_state', 'meta', this.meta, wctx(`meta-${endOffset}`));
  }
}

const hazardIdOf = (fireIdValue: string): string => hazardId('SATELIT', fireIdValue);
