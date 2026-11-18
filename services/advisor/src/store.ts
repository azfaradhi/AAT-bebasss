import type { StorageClient, WriteCtx } from '../../../shared-types/src/m2/types';
import { LABEL, type FireFacts, type Severity } from './facts';

export interface Advisory {
  hazard_id: string;
  based_on_count: number;
  flagged: true;
  score: number;
  reasons: string[];
  summary: string;
  summary_source: 'llm' | 'template';
  model: string | null;
  label: typeof LABEL;
  generated_at: string;
}

export interface EventSource { fires(): Promise<FireFacts[]> }

// Reads published fire events; never writes them.
export class StorageEventSource implements EventSource {
  constructor(private readonly storage: StorageClient) {}

  async fires(): Promise<FireFacts[]> {
    const out: FireFacts[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.storage.listEvents({ source: 'SATELIT', limit: 500, cursor });
      for (const e of page.items) {
        const a = e.attributes as { detection_count?: number; satellites?: string[]; total_frp_mw?: number };
        out.push({
          id: e.hazard_id, province: e.area_name, count: a.detection_count ?? 0, satellites: a.satellites ?? [],
          frp: a.total_frp_mw ?? 0, severity: e.severity as Severity, earliest: e.occurred_at,
        });
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return out;
  }
}

// Advisory records live under their own key prefix; nothing else reads or writes it.
export class StorageAdvisoryStore {
  constructor(private readonly storage: StorageClient) {}

  private ctx(key: string): WriteCtx { return { fence: 1, idempotencyKey: key, correlationId: 'advisor', fenceName: 'advisor' }; }

  async put(rec: Advisory): Promise<void> {
    await this.storage.putDoc('fire_state', `advisory:${rec.hazard_id}`, rec, this.ctx(`advisory-${rec.hazard_id}-${rec.summary_source}`));
  }

  async get(id: string): Promise<Advisory | null> { return this.storage.getDoc<Advisory>('fire_state', `advisory:${id}`); }

  async list(limit: number, id?: string): Promise<Advisory[]> {
    if (id) { const one = await this.get(id); return one ? [one] : []; }
    const page = await this.storage.listDocs<Advisory>('fire_state', { prefix: 'advisory:', limit });
    return page.items.map((i) => i.doc);
  }
}
