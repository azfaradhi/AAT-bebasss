import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { HazardEvent, HazardEventResponse, HazardSource, HazardType } from '../../../../shared-types/src/hazard-event';

export const DEFAULT_LIST_LIMIT = 500;
export const MAX_LIST_LIMIT = 1000;

export interface HazardQuery {
  hazardType?: HazardType;
  since?: string;
  limit?: number;
}

export interface StoredHazard {
  event: HazardEvent;
  created: boolean;
}

export interface PendingHazardPublication {
  messageId: string;
  correlationId: string;
  event: HazardEvent;
}

export interface CanonicalStore {
  init(): Promise<void>;
  upsert(event: HazardEvent, correlationId: string): Promise<StoredHazard>;
  claimPendingPublication(leaseMs: number): Promise<PendingHazardPublication | null>;
  markPublicationSent(messageId: string): Promise<void>;
  releasePublication(messageId: string): Promise<void>;
  list(query?: HazardQuery): Promise<HazardEventResponse>;
  getLastSuccessAt(source: HazardSource): Promise<Date | null>;
  markSourceFresh(source: HazardSource): Promise<void>;
  markSourceStale(source: HazardSource): Promise<void>;
  close(): Promise<void>;
}

// Only the sources that feed a given hazard type can make its responses stale (spec P2: seismic stays normal during a PVMBG outage).
export function staleSourcesFor(hazardType?: HazardType): HazardSource[] {
  if (hazardType === 'SEISMIC') return ['BMKG'];
  if (hazardType === 'VOLCANIC') return ['PVMBG'];
  return ['BMKG', 'PVMBG'];
}

export function clampLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIST_LIMIT);
}

interface HazardRow {
  hazard_id: string;
  source: HazardSource;
  source_ref_id: string;
  hazard_type: HazardType;
  severity: HazardEvent['severity'];
  area_name: string;
  latitude: number;
  longitude: number;
  occurred_at: Date;
  ingested_at: Date;
  attributes: Record<string, unknown>;
  created: boolean;
}

export class PostgresCanonicalStore implements CanonicalStore {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS hazard_events (
        hazard_id UUID PRIMARY KEY,
        source TEXT NOT NULL,
        source_ref_id TEXT NOT NULL,
        hazard_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        area_name TEXT NOT NULL,
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        ingested_at TIMESTAMPTZ NOT NULL,
        attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (source, source_ref_id)
      );
      CREATE INDEX IF NOT EXISTS hazard_events_type_occurred_idx ON hazard_events (hazard_type, occurred_at DESC);
      CREATE TABLE IF NOT EXISTS source_sync_state (
        source TEXT PRIMARY KEY,
        stale_since TIMESTAMPTZ NULL,
        last_success_at TIMESTAMPTZ NULL
      );
      CREATE TABLE IF NOT EXISTS hazard_event_outbox (
        message_id UUID PRIMARY KEY,
        hazard_id UUID NOT NULL UNIQUE REFERENCES hazard_events(hazard_id),
        correlation_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        published_at TIMESTAMPTZ NULL,
        locked_until TIMESTAMPTZ NULL,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS hazard_event_outbox_pending_idx
        ON hazard_event_outbox (next_attempt_at, created_at) WHERE published_at IS NULL;
    `);
  }

  // The event and its publication intent commit together. A broker failure cannot lose the intent.
  async upsert(event: HazardEvent, correlationId: string): Promise<StoredHazard> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<HazardRow>(`
      INSERT INTO hazard_events (
        hazard_id, source, source_ref_id, hazard_type, severity, area_name, latitude, longitude, occurred_at, ingested_at, attributes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      ON CONFLICT (source, source_ref_id) DO UPDATE SET
        hazard_type = EXCLUDED.hazard_type,
        severity = EXCLUDED.severity,
        area_name = EXCLUDED.area_name,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        occurred_at = EXCLUDED.occurred_at,
        ingested_at = EXCLUDED.ingested_at,
        attributes = EXCLUDED.attributes,
        updated_at = now()
      RETURNING *, (xmax = 0) AS created;
      `, [
        event.hazard_id || randomUUID(), event.source, event.source_ref_id, event.hazard_type, event.severity,
        event.area_name, event.latitude, event.longitude, event.occurred_at, event.ingested_at, JSON.stringify(event.attributes),
      ]);
      const row = result.rows[0];
      const stored = { event: this.toHazardEvent(row), created: row.created };
      if (stored.created) {
        await client.query(`
          INSERT INTO hazard_event_outbox (message_id, hazard_id, correlation_id, payload)
          VALUES ($1, $2, $3, $4::jsonb);
        `, [randomUUID(), stored.event.hazard_id, correlationId, JSON.stringify(stored.event)]);
      }
      await client.query('COMMIT');
      return stored;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async claimPendingPublication(leaseMs: number): Promise<PendingHazardPublication | null> {
    const result = await this.pool.query<{
      message_id: string;
      correlation_id: string;
      payload: HazardEvent;
    }>(`
      UPDATE hazard_event_outbox AS outbox
      SET locked_until = now() + ($1::int * interval '1 millisecond'), attempts = attempts + 1
      WHERE message_id = (
        SELECT message_id FROM hazard_event_outbox
        WHERE published_at IS NULL AND next_attempt_at <= now()
          AND (locked_until IS NULL OR locked_until <= now())
        ORDER BY created_at, message_id
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING outbox.message_id, outbox.correlation_id, outbox.payload;
    `, [leaseMs]);
    const row = result.rows[0];
    return row ? { messageId: row.message_id, correlationId: row.correlation_id, event: row.payload } : null;
  }

  async markPublicationSent(messageId: string): Promise<void> {
    await this.pool.query(`
      UPDATE hazard_event_outbox SET published_at = now(), locked_until = NULL
      WHERE message_id = $1 AND published_at IS NULL;
    `, [messageId]);
  }

  async releasePublication(messageId: string): Promise<void> {
    await this.pool.query(`
      UPDATE hazard_event_outbox
      SET locked_until = NULL, next_attempt_at = now() + interval '1 second'
      WHERE message_id = $1 AND published_at IS NULL;
    `, [messageId]);
  }

  async list(query: HazardQuery = {}): Promise<HazardEventResponse> {
    const [events, state] = await Promise.all([
      this.pool.query<HazardRow>(`
        SELECT hazard_id, source, source_ref_id, hazard_type, severity, area_name, latitude, longitude, occurred_at, ingested_at, attributes, false AS created
        FROM hazard_events
        WHERE ($1::text IS NULL OR hazard_type = $1)
          AND ($2::timestamptz IS NULL OR occurred_at >= $2)
        ORDER BY occurred_at DESC
        LIMIT $3;
      `, [query.hazardType ?? null, query.since ?? null, clampLimit(query.limit)]),
      this.pool.query<{ stale_since: Date | null }>(
        'SELECT MIN(stale_since) AS stale_since FROM source_sync_state WHERE stale_since IS NOT NULL AND source = ANY($1::text[]);',
        [staleSourcesFor(query.hazardType)],
      ),
    ]);
    return {
      data: events.rows.map((row) => this.toHazardEvent(row)),
      meta: { stale_since: state.rows[0]?.stale_since?.toISOString() ?? null },
    };
  }

  async getLastSuccessAt(source: HazardSource): Promise<Date | null> {
    const result = await this.pool.query<{ last_success_at: Date | null }>(
      'SELECT last_success_at FROM source_sync_state WHERE source = $1;',
      [source],
    );
    return result.rows[0]?.last_success_at ?? null;
  }

  async markSourceFresh(source: HazardSource): Promise<void> {
    await this.pool.query(`
      INSERT INTO source_sync_state (source, stale_since, last_success_at) VALUES ($1, NULL, now())
      ON CONFLICT (source) DO UPDATE SET stale_since = NULL, last_success_at = now();
    `, [source]);
  }

  async markSourceStale(source: HazardSource): Promise<void> {
    await this.pool.query(`
      INSERT INTO source_sync_state (source, stale_since) VALUES ($1, now())
      ON CONFLICT (source) DO UPDATE SET stale_since = COALESCE(source_sync_state.stale_since, now());
    `, [source]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private toHazardEvent(row: HazardRow): HazardEvent {
    return {
      hazard_id: row.hazard_id,
      source: row.source,
      source_ref_id: row.source_ref_id,
      hazard_type: row.hazard_type,
      severity: row.severity,
      area_name: row.area_name,
      latitude: row.latitude,
      longitude: row.longitude,
      occurred_at: row.occurred_at.toISOString(),
      ingested_at: row.ingested_at.toISOString(),
      attributes: row.attributes,
    };
  }
}
