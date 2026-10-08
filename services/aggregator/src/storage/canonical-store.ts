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

export interface CanonicalStore {
  init(): Promise<void>;
  upsert(event: HazardEvent): Promise<StoredHazard>;
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
    `);
  }

  // hazard_id is generated here on first insert and kept on conflict, so it stays stable across polls.
  async upsert(event: HazardEvent): Promise<StoredHazard> {
    const result = await this.pool.query<HazardRow>(`
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
    return { event: this.toHazardEvent(row), created: row.created };
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
