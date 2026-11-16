import { reportId } from './m2/ids';
import type {
  AuditProviders, FieldReportAudit, FieldReportRequest, Page, StorageClient, StoredFieldReport, WriteCtx,
} from './m2/types';

const C = 'field_reports' as const;
const CATEGORIES = ['KORBAN', 'KERUSAKAN', 'KEBUTUHAN', 'LAINNYA'];
export const MAX_REPORT_BYTES = 16 * 1024;
export const MAX_KEY_LENGTH = 200;

export type Validation = { ok: true; value: FieldReportRequest } | { ok: false; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateFieldReport(body: unknown): Validation {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' };
  const { category, description, latitude, longitude, observed_at, hazard_ref, attributes } = body;
  if (typeof category !== 'string' || !CATEGORIES.includes(category)) return { ok: false, message: `category must be one of ${CATEGORIES.join(', ')}` };
  if (typeof description !== 'string' || description.length === 0 || description.length > 4000) return { ok: false, message: 'description must be 1 to 4000 characters' };
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) return { ok: false, message: 'latitude must be a number in [-90, 90]' };
  if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return { ok: false, message: 'longitude must be a number in [-180, 180]' };
  if (typeof observed_at !== 'string' || Number.isNaN(Date.parse(observed_at))) return { ok: false, message: 'observed_at must be an ISO-8601 timestamp' };
  if (hazard_ref !== undefined && (typeof hazard_ref !== 'string' || hazard_ref.length > 200)) return { ok: false, message: 'hazard_ref must be a string of at most 200 characters' };
  if (attributes !== undefined && !isObject(attributes)) return { ok: false, message: 'attributes must be an object' };
  return {
    ok: true,
    value: {
      category: category as FieldReportRequest['category'], description, latitude, longitude, observed_at,
      ...(hazard_ref !== undefined ? { hazard_ref: hazard_ref as string } : {}),
      ...(attributes !== undefined ? { attributes: attributes as Record<string, unknown> } : {}),
    },
  };
}

export interface FieldReportStoreOptions { clock?: () => number }
export interface AcceptResult { report_id: string; received_at: string; duplicate: boolean }

// Durable field-report records in the ring (collection `field_reports`):
//   r:<id> the report, p:<id> pending marker (deleted once processed), d:<id>:<correlation> one record per repeated request.
export class FieldReportStore {
  private readonly clock: () => number;

  constructor(private readonly storage: StorageClient, opts: FieldReportStoreOptions = {}) {
    this.clock = opts.clock ?? Date.now;
  }

  private iso(): string { return new Date(this.clock()).toISOString(); }

  // The intake handlers are not leaders, so they write with a constant fence on their own fence name.
  private intakeCtx(key: string, correlationId: string): WriteCtx {
    return { fence: 1, idempotencyKey: key, correlationId, fenceName: 'field-reports-intake' };
  }

  // Returns only after the report and its pending marker are durably written.
  async accept(reporter: string, idempotencyKey: string, body: FieldReportRequest, correlationId: string): Promise<AcceptResult> {
    const id = reportId(reporter, idempotencyKey);
    const existing = await this.storage.getDoc<StoredFieldReport>(C, `r:${id}`);
    if (existing) {
      await this.storage.putDoc(C, `d:${id}:${correlationId}`, { report_id: id, at: this.iso() }, this.intakeCtx(`d-${id}-${correlationId}`, correlationId));
      if (!existing.processed_at && !(await this.storage.getDoc(C, `p:${id}`))) {
        await this.storage.putDoc(C, `p:${id}`, { report_id: id }, this.intakeCtx(`p-${id}`, correlationId)); // repairs a crash between the two writes
      }
      return { report_id: id, received_at: existing.received_at, duplicate: true };
    }
    const received_at = this.iso();
    const doc: StoredFieldReport = { ...body, report_id: id, reporter, received_at, processed_at: null };
    await this.storage.putDoc(C, `r:${id}`, doc, this.intakeCtx(`r-${id}`, correlationId));
    await this.storage.putDoc(C, `p:${id}`, { report_id: id }, this.intakeCtx(`p-${id}`, correlationId));
    return { report_id: id, received_at, duplicate: false };
  }

  // Marks pending reports processed. Safe to run any number of times, from any restart point.
  async sweep(fence: number, limit = 200): Promise<{ processed: number; cleaned: number }> {
    const ctx = (key: string): WriteCtx => ({ fence, idempotencyKey: key, correlationId: 'field-report-sweep', fenceName: 'field-reports' });
    const page = await this.storage.listDocs<{ report_id: string }>(C, { prefix: 'p:', limit });
    let processed = 0;
    let cleaned = 0;
    for (const { key } of page.items) {
      const id = key.slice(2);
      const report = await this.storage.getDoc<StoredFieldReport>(C, `r:${id}`);
      if (!report) continue;
      if (!report.processed_at) {
        await this.storage.putDoc(C, `r:${id}`, { ...report, processed_at: this.iso() }, ctx(`proc-${id}`));
        processed++;
      } else cleaned++;
      await this.storage.deleteDoc(C, key, ctx(`clear-${id}`));
    }
    return { processed, cleaned };
  }

  // Re-creates the pending marker of any unprocessed report that lost it.
  async reconcile(fence: number): Promise<number> {
    const ctx = (key: string): WriteCtx => ({ fence, idempotencyKey: key, correlationId: 'field-report-reconcile', fenceName: 'field-reports' });
    let repaired = 0;
    let cursor: string | undefined;
    do {
      const page = await this.storage.listDocs<StoredFieldReport>(C, { prefix: 'r:', limit: 500, cursor });
      for (const { doc } of page.items) {
        if (doc.processed_at) continue;
        if (!(await this.storage.getDoc(C, `p:${doc.report_id}`))) {
          await this.storage.putDoc(C, `p:${doc.report_id}`, { report_id: doc.report_id }, ctx(`p-${doc.report_id}`));
          repaired++;
        }
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return repaired;
  }

  async audit(q: { limit: number; cursor?: string }): Promise<FieldReportAudit & { next_cursor: string | null }> {
    let accepted = 0;
    let processed = 0;
    let partial = false;
    const unavailable = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.storage.listDocs<StoredFieldReport>(C, { prefix: 'r:', limit: 500, cursor });
      for (const { doc } of page.items) { accepted++; if (doc.processed_at) processed++; }
      partial ||= page.partial;
      page.unavailable_units.forEach((u) => unavailable.add(u));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);

    let duplicates = 0;
    let dupCursor: string | undefined;
    do {
      const page: Page<{ key: string; doc: unknown }> = await this.storage.listDocs(C, { prefix: 'd:', limit: 500, cursor: dupCursor });
      duplicates += page.items.length;
      partial ||= page.partial;
      page.unavailable_units.forEach((u) => unavailable.add(u));
      dupCursor = page.next_cursor ?? undefined;
    } while (dupCursor);

    const items = await this.storage.listDocs<StoredFieldReport>(C, { prefix: 'r:', limit: q.limit, cursor: q.cursor });
    return {
      accepted_total: accepted, processed_total: processed, duplicates_dropped_total: duplicates,
      items: items.items.map((i) => i.doc.report_id),
      partial: partial || items.partial, unavailable_units: [...new Set([...unavailable, ...items.unavailable_units])],
      next_cursor: items.next_cursor,
    };
  }
}

export function fieldReportsProvider(store: FieldReportStore): AuditProviders['fieldReports'] {
  return (q) => store.audit(q);
}
