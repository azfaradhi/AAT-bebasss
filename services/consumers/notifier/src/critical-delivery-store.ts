/**
 * Critical Alert Delivery Store & AuditProvider implementation (P5-K1, MB3-T10).
 * Tracks every delivered CriticalAlertMessage with exact E2E latency and p95 calculation.
 */
import type { DeliveryRecord } from '../../../../shared-types/src/m2/types';

export class CriticalDeliveryStore {
  private readonly recordsByMessageId = new Map<string, DeliveryRecord>();
  private readonly seenHazardIds = new Set<string>();
  private readonly ordered: DeliveryRecord[] = [];

  hasSeen(messageId: string, hazardId: string): boolean {
    return this.recordsByMessageId.has(messageId) || this.seenHazardIds.has(hazardId);
  }

  record(rec: DeliveryRecord): boolean {
    if (this.hasSeen(rec.message_id, rec.hazard_id)) {
      return false;
    }
    this.recordsByMessageId.set(rec.message_id, rec);
    this.seenHazardIds.add(rec.hazard_id);
    this.ordered.push(rec);
    return true;
  }

  async criticalDeliveries(q: { limit: number; cursor?: string }): Promise<{
    items: DeliveryRecord[];
    total: number;
    p95_seconds: number | null;
    next_cursor: string | null;
  }> {
    let startIdx = 0;
    if (q.cursor) {
      const idx = this.ordered.findIndex((r) => r.message_id === q.cursor);
      if (idx >= 0) startIdx = idx + 1;
    }
    const page = this.ordered.slice(startIdx, startIdx + q.limit);
    const more = startIdx + page.length < this.ordered.length;
    const nextCursor = more && page.length > 0 ? page[page.length - 1].message_id : null;

    return {
      items: page,
      total: this.ordered.length,
      p95_seconds: this.computeP95Seconds(),
      next_cursor: nextCursor,
    };
  }

  computeP95Seconds(): number | null {
    if (this.ordered.length === 0) return null;
    const sorted = this.ordered.map((r) => r.e2e_seconds).sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    return Number(sorted[idx].toFixed(4));
  }
}
