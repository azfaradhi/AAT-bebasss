import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FencedError, type OutboxItem, type UnitState } from '../../../shared-types/src/m2/types';
import { compareBytes, compareEvents, outboxMessageId } from '../../../shared-types/src/m2/ids';
import type { UnitCtx, UnitDocEntry, UnitDump, UnitOutboxSpec, UnitRow, UnitStats } from '../../../shared-types/src/ring/protocol';

interface OutboxEntry { item: OutboxItem; published: boolean; leaseUntil: number }
type LogOp =
  | { k: 'row'; row: UnitRow } | { k: 'doc'; c: string; entry: UnitDocEntry } | { k: 'fence'; name: string; token: number }
  | { k: 'outbox'; item: OutboxItem } | { k: 'pub'; ids: string[] };

export interface EngineOptions { unit: string; node: string; dataDir?: string; now?: () => number; initialState?: UnitState }

// One storage unit's local state: rows, documents, fences and outbox, with an append-only log when a data dir is set.
export class UnitEngine {
  readonly unit: string;
  readonly node: string;
  state: UnitState;
  private rows = new Map<string, UnitRow>();
  private docs = new Map<string, UnitDocEntry>();
  private fences = new Map<string, number>();
  private outbox = new Map<string, OutboxEntry>();
  private writes = 0;
  private logPath: string | null = null;
  private readonly now: () => number;

  constructor(opts: EngineOptions) {
    this.unit = opts.unit;
    this.node = opts.node;
    this.now = opts.now ?? Date.now;
    this.state = opts.initialState ?? 'STABLE';
    if (opts.dataDir) {
      mkdirSync(opts.dataDir, { recursive: true });
      this.logPath = join(opts.dataDir, `${opts.unit}.log`);
      if (existsSync(this.logPath)) {
        this.replay(readFileSync(this.logPath, 'utf8'));
        if (!opts.initialState) this.state = 'RECOVERING';
      } else if (!opts.initialState) this.state = 'JOINING';
    }
  }

  private persist(op: LogOp): void {
    if (this.logPath) appendFileSync(this.logPath, JSON.stringify(op) + '\n');
  }
  private replay(text: string): void {
    for (const line of text.split('\n')) {
      if (!line) continue;
      let op: LogOp;
      try { op = JSON.parse(line) as LogOp; } catch { continue; }
      if (op.k === 'row') this.rows.set(op.row.hazard_id, op.row);
      else if (op.k === 'doc') this.docs.set(`${op.c}/${op.entry.key}`, op.entry);
      else if (op.k === 'fence') this.fences.set(op.name, op.token);
      else if (op.k === 'outbox') this.outbox.set(op.item.message_id, { item: op.item, published: false, leaseUntil: 0 });
      else for (const id of op.ids) { const o = this.outbox.get(id); if (o) o.published = true; }
    }
  }
  private checkFence(ctx: UnitCtx): void {
    const cur = this.fences.get(ctx.fenceName) ?? 0;
    if (ctx.fence < cur) throw new FencedError(ctx.fenceName, ctx.fence, cur);
  }

  /* events */
  upsert(e: UnitRow, ctx: UnitCtx, outbox?: UnitOutboxSpec): { created: boolean; applied: boolean } {
    this.checkFence(ctx);
    const existing = this.rows.get(e.hazard_id);
    if (existing && e.version <= existing.version) return { created: false, applied: false };
    const row: UnitRow = { ...e, ingested_at: existing ? existing.ingested_at : e.ingested_at };
    delete row.tombstone;
    this.rows.set(e.hazard_id, row);
    this.persist({ k: 'row', row });
    this.writes++;
    const created = !existing;
    const mode = outbox?.mode ?? 'on_create';
    if (mode === 'on_apply' || (mode === 'on_create' && created)) {
      const id = outboxMessageId(e.hazard_id, e.version);
      if (!this.outbox.has(id)) {
        const item: OutboxItem = { message_id: id, hazard_id: e.hazard_id, event: { ...row }, priority: outbox?.priority ?? 'normal', correlation_id: outbox?.correlation_id ?? 'unknown', attempts: 0 };
        this.outbox.set(id, { item, published: false, leaseUntil: 0 });
        this.persist({ k: 'outbox', item });
      }
    }
    return { created, applied: true };
  }
  tombstone(hazardId: string, version: number, ctx: UnitCtx, mergedInto?: string): { applied: boolean } {
    this.checkFence(ctx);
    const cur = this.rows.get(hazardId);
    if (!cur || version <= cur.version) return { applied: false };
    const row: UnitRow = { ...cur, version, tombstone: true, merged_into: mergedInto };
    this.rows.set(hazardId, row);
    this.persist({ k: 'row', row });
    this.writes++;
    return { applied: true };
  }
  get(hazardId: string): UnitRow | null { return this.rows.get(hazardId) ?? null; }
  list(q: { source?: string; hazardType?: string; since?: string; afterT?: string; afterH?: string; limit: number }): UnitRow[] {
    const after = q.afterT !== undefined && q.afterH !== undefined ? { ingested_at: q.afterT, hazard_id: q.afterH } : null;
    return [...this.rows.values()]
      .filter((r) => (!q.source || r.source === q.source) && (!q.hazardType || r.hazard_type === q.hazardType) && (!q.since || r.ingested_at >= q.since) && (!after || compareEvents(r, after) > 0))
      .sort(compareEvents)
      .slice(0, q.limit);
  }
  scan(source?: string): UnitRow[] { return [...this.rows.values()].filter((r) => !source || r.source === source); }

  /* docs */
  putDoc(c: string, key: string, doc: unknown, ctx: UnitCtx, version?: number): { applied: boolean; version: number } {
    this.checkFence(ctx);
    const cur = this.docs.get(`${c}/${key}`);
    if (version !== undefined && cur && version < cur.version) return { applied: false, version: cur.version };
    // Unversioned writes take a time-ordered version so replicas that missed writes still converge.
    const v = version ?? Math.max((cur?.version ?? 0) + 1, this.now());
    const entry: UnitDocEntry = { key, doc: structuredClone(doc), version: v };
    this.docs.set(`${c}/${key}`, entry);
    this.persist({ k: 'doc', c, entry });
    this.writes++;
    return { applied: true, version: v };
  }
  getDoc(c: string, key: string): UnitDocEntry | null { return this.docs.get(`${c}/${key}`) ?? null; }
  deleteDoc(c: string, key: string, ctx: UnitCtx): void {
    this.checkFence(ctx);
    const cur = this.docs.get(`${c}/${key}`);
    const entry: UnitDocEntry = { key, doc: null, version: Math.max((cur?.version ?? 0) + 1, this.now()), deleted: true };
    this.docs.set(`${c}/${key}`, entry);
    this.persist({ k: 'doc', c, entry });
    this.writes++;
  }
  listDocs(c: string, q: { prefix?: string; after?: string; limit: number }): UnitDocEntry[] {
    const pre = `${c}/`;
    return [...this.docs.entries()]
      .filter(([k]) => k.startsWith(pre))
      .map(([, e]) => e)
      .filter((e) => (!q.prefix || e.key.startsWith(q.prefix)) && (q.after === undefined || compareBytes(e.key, q.after) > 0))
      .sort((a, b) => compareBytes(a.key, b.key))
      .slice(0, q.limit);
  }

  /* outbox */
  claim(max: number, leaseMs: number): OutboxItem[] {
    const t = this.now();
    const out: OutboxItem[] = [];
    for (const o of this.outbox.values()) {
      if (out.length >= max) break;
      if (o.published || o.leaseUntil > t) continue;
      o.leaseUntil = t + leaseMs;
      o.item.attempts += 1;
      out.push({ ...o.item });
    }
    return out;
  }
  markPublished(ids: string[]): void {
    const hit = ids.filter((id) => this.outbox.has(id));
    for (const id of hit) this.outbox.get(id)!.published = true;
    if (hit.length) this.persist({ k: 'pub', ids: hit });
  }
  pending(): string[] { return [...this.outbox.values()].filter((o) => !o.published).map((o) => o.item.message_id); }

  /* fencing */
  raiseFence(name: string, token: number): void {
    const next = Math.max(this.fences.get(name) ?? 0, token);
    this.fences.set(name, next);
    this.persist({ k: 'fence', name, token: next });
  }

  /* repair */
  dump(): UnitDump {
    const docs: UnitDump['docs'] = [];
    for (const [k, e] of this.docs) docs.push({ ...e, collection: k.slice(0, k.indexOf('/')) });
    return { rows: [...this.rows.values()], docs, fences: Object.fromEntries(this.fences) };
  }
  // Merges repair data with last-writer-wins; bypasses fencing because it only fills in what the unit already should have.
  apply(d: UnitDump): void {
    for (const r of d.rows) {
      const cur = this.rows.get(r.hazard_id);
      if (!cur || r.version > cur.version) { this.rows.set(r.hazard_id, r); this.persist({ k: 'row', row: r }); }
    }
    for (const e of d.docs) {
      const key = `${e.collection}/${e.key}`;
      const cur = this.docs.get(key);
      if (!cur || e.version > cur.version) {
        const { collection, ...entry } = e;
        this.docs.set(key, entry);
        this.persist({ k: 'doc', c: collection, entry });
      }
    }
    for (const [n, t] of Object.entries(d.fences)) this.raiseFence(n, t);
  }
  stats(): UnitStats { return { keys: this.rows.size + this.docs.size, writes_total: this.writes }; }
}
