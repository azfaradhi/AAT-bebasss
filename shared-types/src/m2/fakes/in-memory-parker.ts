/**
 * REFERENCE IMPLEMENTATION of Parker (contract §4.3) on top of any StorageClient (docs collection `parked`).
 */
import { createHash } from 'node:crypto';
import type {
  GuardLimits, GuardResult, Page, ParkedMessage, Parker, ReasonCode, ReplayReport, StorageClient, WriteCtx, ParkSource,
} from '../types.js';
import { messageId, compareBytes, encodeCursor } from '../ids.js';

export const DEFAULT_LIMITS: GuardLimits = { maxBytes: 262_144, maxDepth: 32 };
export const MAX_PARK_RAW_BYTES = 1_048_576;
export const MAX_ATTEMPTS = 8;
const RETRYABLE: ReadonlySet<ReasonCode> = new Set(['DOWNSTREAM_UNAVAILABLE', 'STORAGE_PARTIAL', 'TIMEOUT', 'BROKER_UNAVAILABLE', 'RATE_LIMITED']);

export function backoffCeilingMs(attempts: number): number { return Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1)); }

export function guardBytes(raw: Uint8Array, limits: Partial<GuardLimits> = {}): GuardResult {
  const { maxBytes, maxDepth } = { ...DEFAULT_LIMITS, ...limits };
  if (raw.byteLength > maxBytes) return { ok: false, reason_code: 'PAYLOAD_TOO_LARGE', detail: `${raw.byteLength} bytes > ${maxBytes}` };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return { ok: false, reason_code: 'INVALID_UTF8', detail: 'not valid UTF-8' }; }
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') { depth++; if (depth > maxDepth) return { ok: false, reason_code: 'NESTING_TOO_DEEP', detail: `depth > ${maxDepth}` }; }
    else if (ch === '}' || ch === ']') depth--;
  }
  try { return { ok: true, json: JSON.parse(text) }; } catch (e) { return { ok: false, reason_code: 'MALFORMED_JSON', detail: (e as Error).message.slice(0, 200) }; }
}

export class StorageBackedParker implements Parker {
  constructor(private readonly storage: StorageClient, private readonly clock: () => number = Date.now) {}
  private iso(ms = this.clock()): string { return new Date(ms).toISOString(); }

  guard(raw: Uint8Array, limits?: Partial<GuardLimits>): GuardResult { return guardBytes(raw, limits); }

  async park(m: { source: ParkSource; raw: Uint8Array; reason_code: ReasonCode; detail: string; orderingKey?: string; correlationId?: string; retryAfterMs?: number }, ctx: WriteCtx): Promise<ParkedMessage> {
    const id = messageId(m.source, m.raw);
    const prev = await this.storage.getDoc<ParkedMessage>('parked', id);
    const attempts = (prev?.attempts ?? 0) + 1;
    const retryable = RETRYABLE.has(m.reason_code) || m.reason_code === 'RETRIES_EXHAUSTED';
    let reason_code = m.reason_code;
    let status: ParkedMessage['status'] = retryable ? 'retrying' : 'parked';
    if (retryable && attempts >= MAX_ATTEMPTS) { reason_code = 'RETRIES_EXHAUSTED'; status = 'parked'; }
    const now = this.clock();
    const truncated = m.raw.byteLength > MAX_PARK_RAW_BYTES;
    const rec: ParkedMessage = {
      message_id: id, source: m.source,
      received_at: prev?.received_at ?? this.iso(now), first_failed_at: prev?.first_failed_at ?? this.iso(now), last_attempt_at: this.iso(now),
      next_attempt_at: status === 'retrying' ? this.iso(now + (m.retryAfterMs ?? backoffCeilingMs(attempts))) : null,
      reason_code, reason: `${reason_code.toLowerCase()}: ${m.detail}`.slice(0, 500),
      retryable, attempts, status,
      raw_b64: Buffer.from(truncated ? m.raw.subarray(0, MAX_PARK_RAW_BYTES) : m.raw).toString('base64'),
      raw_truncated: truncated, raw_sha256: createHash('sha256').update(m.raw).digest('hex'), raw_size: m.raw.byteLength,
      ordering_key: m.orderingKey ?? prev?.ordering_key,
    };
    await this.storage.putDoc('parked', id, rec, ctx);
    return rec;
  }

  async listUnprocessed(q: { source?: ParkSource; limit: number; cursor?: string }): Promise<Page<ParkedMessage>> {
    const items: ParkedMessage[] = [];
    let cursor = q.cursor, partial = false, unavailable: string[] = [];
    for (;;) {
      const p = await this.storage.listDocs<ParkedMessage>('parked', { limit: 200, cursor });
      partial ||= p.partial; unavailable = [...new Set([...unavailable, ...p.unavailable_units])];
      for (const { doc } of p.items) if (doc.status !== 'recovered' && (!q.source || doc.source === q.source)) items.push(doc);
      cursor = p.next_cursor ?? undefined;
      if (items.length >= q.limit || !cursor) break;
    }
    const page = items.slice(0, q.limit);
    const more = items.length > page.length || !!cursor;
    return { items: page, next_cursor: more && page.length ? encodeCursor({ t: '', h: page[page.length - 1].message_id }) : null, partial, unavailable_units: unavailable };
  }

  async get(id: string): Promise<ParkedMessage | null> { return this.storage.getDoc<ParkedMessage>('parked', id); }

  async replay(q: { reason_code?: ReasonCode; source?: ParkSource; includeRetryable?: boolean }, handler: (raw: Uint8Array, meta: ParkedMessage) => Promise<void>, ctx: WriteCtx): Promise<ReplayReport> {
    const all: ParkedMessage[] = [];
    let cursor: string | undefined;
    do {
      const p = await this.storage.listDocs<ParkedMessage>('parked', { limit: 200, cursor });
      for (const { doc } of p.items) all.push(doc);
      cursor = p.next_cursor ?? undefined;
    } while (cursor);
    const report: ReplayReport = { considered: 0, recovered: 0, still_failing: 0, skipped_already_recovered: 0, per_key_order_violations: 0 };
    const todo: ParkedMessage[] = [];
    for (const m of all) {
      if (m.status === 'recovered') { report.skipped_already_recovered++; continue; }
      if (m.status === 'retrying' && !q.includeRetryable) continue;
      if (q.reason_code && m.reason_code !== q.reason_code) continue;
      if (q.source && m.source !== q.source) continue;
      todo.push(m);
    }
    report.considered = todo.length;
    const groups = new Map<string, ParkedMessage[]>();
    for (const m of todo) { const k = m.ordering_key ? `${m.source}|${m.ordering_key}` : `solo|${m.message_id}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(m); }
    await Promise.all([...groups.values()].map(async (list) => {
      list.sort((a, b) => compareBytes(a.received_at, b.received_at) || compareBytes(a.message_id, b.message_id));
      for (const m of list) {
        try {
          await handler(new Uint8Array(Buffer.from(m.raw_b64, 'base64')), m);
          await this.storage.putDoc('parked', m.message_id, { ...m, status: 'recovered', recovered_at: this.iso(), next_attempt_at: null } satisfies ParkedMessage, ctx);
          report.recovered++;
        } catch {
          await this.storage.putDoc('parked', m.message_id, { ...m, attempts: m.attempts + 1, last_attempt_at: this.iso() }, ctx);
          report.still_failing++;
          break;
        }
      }
    }));
    return report;
  }
}
