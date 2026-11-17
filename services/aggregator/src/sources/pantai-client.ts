/**
 * Sensor Pantai Client, Behavior-Based Validator & Fenced Leader Poller (MB3-T08, P5-K1..K4)
 * Zero hardcoded IDs: validates schema, runtime types, physical bounds, quality flag,
 * station catalog membership, timestamp staleness, and conflicting duplicate IDs.
 */
import { randomUUID } from 'node:crypto';
import {
  LEADER_NAMES,
  type Coordinator,
  type CriticalAlertMessage,
  type FenceToken,
  type PantaiObservation,
  type PantaiStation,
  type Parker,
  type StorageClient,
  type WriteCtx,
} from '../../../../shared-types/src/m2/types';
import { hazardId, nextIngestedAt, outboxMessageId } from '../../../../shared-types/src/m2/ids';
import { mapCoastalObservation } from '../mapping/coastal-mapper';
import { Bulkhead, CircuitBreaker, retryWithBackoff } from '../resilience/index';
import { METRICS, incCounter, instrumentOutbound } from '../resilience/obs';

export type ObservationValidationResult =
  | { status: 'valid'; observation: PantaiObservation; fingerprint: string }
  | { status: 'duplicate'; observationId: string }
  | { status: 'violation'; detail: string; orderingKey?: string };

export interface ValidationOptions {
  maxStalenessSeconds: number;
  minSeaLevelAnomalyM?: number;
  maxSeaLevelAnomalyM?: number;
  minWaveHeightM?: number;
  maxWaveHeightM?: number;
}

const DEFAULT_VALIDATION_OPTS: Required<ValidationOptions> = {
  maxStalenessSeconds: 3600,
  minSeaLevelAnomalyM: -10,
  maxSeaLevelAnomalyM: 25,
  minWaveHeightM: 0,
  maxWaveHeightM: 40,
};

function observationFingerprint(obs: PantaiObservation): string {
  return `${obs.station_id}|${obs.observed_at}|${obs.sea_level_anomaly_m}|${obs.wave_height_m}|${obs.quality}|${obs.critical}`;
}

/**
 * Pure behavior-based validation of a single raw item from /v1/observations.
 * Never hardcodes any observation_id, station_id, timestamp, or index (P5-K2, C-CLEAN).
 */
export function validatePantaiObservation(
  rawItem: unknown,
  generatedAtIso: string,
  stationsById: ReadonlyMap<string, PantaiStation>,
  seenFingerprints: Map<string, string>,
  opts: Partial<ValidationOptions> = {},
): ObservationValidationResult {
  const cfg = { ...DEFAULT_VALIDATION_OPTS, ...opts };

  if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
    return { status: 'violation', detail: 'invalid_object: observation item is not a JSON object' };
  }

  const rec = rawItem as Record<string, unknown>;
  const obsId = typeof rec['observation_id'] === 'string' && rec['observation_id'].trim().length > 0
    ? rec['observation_id'].trim()
    : undefined;

  // 1. Required fields & strict primitive types (catches numbers-as-strings & missing fields)
  if (!obsId) {
    return { status: 'violation', detail: 'missing_required_field: observation_id must be a non-empty string' };
  }
  if (typeof rec['station_id'] !== 'string' || rec['station_id'].trim().length === 0) {
    return { status: 'violation', detail: 'missing_required_field: station_id must be a non-empty string', orderingKey: obsId };
  }
  if (typeof rec['observed_at'] !== 'string' || rec['observed_at'].trim().length === 0) {
    return { status: 'violation', detail: 'missing_required_field: observed_at must be a non-empty ISO string', orderingKey: obsId };
  }
  if (typeof rec['sea_level_anomaly_m'] !== 'number' || !Number.isFinite(rec['sea_level_anomaly_m'])) {
    return {
      status: 'violation',
      detail: `type_mismatch: sea_level_anomaly_m must be a finite number, got ${typeof rec['sea_level_anomaly_m']}`,
      orderingKey: obsId,
    };
  }
  if (typeof rec['wave_height_m'] !== 'number' || !Number.isFinite(rec['wave_height_m'])) {
    return {
      status: 'violation',
      detail: `type_mismatch: wave_height_m must be a finite number, got ${typeof rec['wave_height_m']}`,
      orderingKey: obsId,
    };
  }
  if (typeof rec['quality'] !== 'string' || rec['quality'].trim().length === 0) {
    return { status: 'violation', detail: 'missing_required_field: quality must be a string', orderingKey: obsId };
  }
  if (typeof rec['critical'] !== 'boolean') {
    return {
      status: 'violation',
      detail: `type_mismatch: critical must be a boolean, got ${typeof rec['critical']}`,
      orderingKey: obsId,
    };
  }

  // 2. Quality flag check. A sensor-flagged critical reading is never dropped for a degraded
  //    quality flag: losing a tsunami alert is worse than alerting on a suspect reading (P5-K1).
  if (rec['quality'] !== 'ok' && rec['critical'] !== true) {
    return {
      status: 'violation',
      detail: `invalid_quality_flag: expected 'ok', got '${rec['quality']}'`,
      orderingKey: obsId,
    };
  }

  // 3. Station existence & valid coordinates
  const station = stationsById.get(rec['station_id']);
  if (!station) {
    return {
      status: 'violation',
      detail: `unknown_station_id: '${rec['station_id']}' is not registered in /v1/stations`,
      orderingKey: obsId,
    };
  }
  if (
    typeof station.latitude !== 'number' || !Number.isFinite(station.latitude) || station.latitude < -90 || station.latitude > 90 ||
    typeof station.longitude !== 'number' || !Number.isFinite(station.longitude) || station.longitude < -180 || station.longitude > 180
  ) {
    return {
      status: 'violation',
      detail: `invalid_station_coordinates: station '${station.station_id}' has invalid lat/lon`,
      orderingKey: obsId,
    };
  }

  // 4. Physical oceanographic bounds
  const sla = rec['sea_level_anomaly_m'];
  const wave = rec['wave_height_m'];
  if (sla < cfg.minSeaLevelAnomalyM || sla > cfg.maxSeaLevelAnomalyM) {
    return {
      status: 'violation',
      detail: `out_of_physical_range: sea_level_anomaly_m=${sla} outside [${cfg.minSeaLevelAnomalyM}, ${cfg.maxSeaLevelAnomalyM}]`,
      orderingKey: obsId,
    };
  }
  if (wave < cfg.minWaveHeightM || wave > cfg.maxWaveHeightM) {
    return {
      status: 'violation',
      detail: `out_of_physical_range: wave_height_m=${wave} outside [${cfg.minWaveHeightM}, ${cfg.maxWaveHeightM}]`,
      orderingKey: obsId,
    };
  }

  // 5. Timestamp parseability & staleness vs generated_at (silent freeze detection)
  const observedMs = Date.parse(rec['observed_at']);
  const generatedMs = Date.parse(generatedAtIso);
  if (!Number.isFinite(observedMs)) {
    return {
      status: 'violation',
      detail: `invalid_timestamp: observed_at '${rec['observed_at']}' is not valid ISO-8601`,
      orderingKey: obsId,
    };
  }
  if (Number.isFinite(generatedMs)) {
    const stalenessSec = (generatedMs - observedMs) / 1000;
    if (stalenessSec > cfg.maxStalenessSeconds) {
      return {
        status: 'violation',
        detail: `stale_observation: age ${Math.round(stalenessSec)}s exceeds max ${cfg.maxStalenessSeconds}s`,
        orderingKey: obsId,
      };
    }
    if (stalenessSec < -60) {
      return {
        status: 'violation',
        detail: `future_observation: observed_at is ${Math.round(-stalenessSec)}s ahead of generated_at`,
        orderingKey: obsId,
      };
    }
  }

  const obs: PantaiObservation = {
    observation_id: obsId,
    station_id: rec['station_id'],
    observed_at: rec['observed_at'],
    sea_level_anomaly_m: sla,
    wave_height_m: wave,
    quality: rec['quality'],
    critical: rec['critical'],
  };

  // 6. Duplicate vs conflicting duplicate observation_id check
  const fp = observationFingerprint(obs);
  const existingFp = seenFingerprints.get(obsId);
  if (existingFp !== undefined) {
    if (existingFp === fp) {
      return { status: 'duplicate', observationId: obsId };
    }
    return {
      status: 'violation',
      detail: `conflicting_duplicate_observation_id: '${obsId}' received with different payload fields`,
      orderingKey: obsId,
    };
  }

  return { status: 'valid', observation: obs, fingerprint: fp };
}

export interface CriticalAlertFastPublisher {
  publishCriticalAlert(msg: CriticalAlertMessage): Promise<void>;
}

export interface PantaiPollerOptions {
  baseUrl: string;
  authToken: string;
  instanceId: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  maxStalenessSeconds?: number;
  breakerFailureThreshold?: number;
  breakerCooldownMs?: number;
  bulkheadMaxConcurrent?: number;
  bulkheadMaxQueue?: number;
  storage: StorageClient;
  coordinator: Coordinator;
  parker: Parker;
  criticalPublisher?: CriticalAlertFastPublisher;
  clock?: () => number;
  fetchFn?: typeof fetch;
}

export class PantaiPoller {
  private readonly stations = new Map<string, PantaiStation>();
  private readonly seenFingerprints = new Map<string, string>();
  private readonly breaker: CircuitBreaker;
  private readonly bulkhead: Bulkhead;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxStalenessSeconds: number;
  private readonly clock: () => number;
  private readonly fetchFn: typeof fetch;
  private lastSuccessAt: string | null = null;
  private stopped = false;

  constructor(private readonly opts: PantaiPollerOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.timeoutMs = opts.timeoutMs ?? 2500;
    this.maxStalenessSeconds = opts.maxStalenessSeconds ?? 3600;
    this.clock = opts.clock ?? Date.now;
    this.fetchFn = opts.fetchFn ?? fetch;

    this.breaker = new CircuitBreaker({
      target: 'sensor-pantai',
      failureThreshold: opts.breakerFailureThreshold ?? 5,
      cooldownMs: opts.breakerCooldownMs ?? 10000,
      timeoutMs: this.timeoutMs,
      now: this.clock,
    });
    this.bulkhead = new Bulkhead(
      'sensor-pantai',
      opts.bulkheadMaxConcurrent ?? 4,
      opts.bulkheadMaxQueue ?? 8,
    );
  }

  /**
   * Non-blocking health & staleness view for read endpoints (P5-K4).
   * When sensor-pantai is down or breaker is open, callers read this in O(1) without waiting on network timeouts.
   */
  getHealthStatus(): { target: 'sensor-pantai'; breakerState: string; stale: boolean; lastSuccessAt: string | null } {
    const state = this.breaker.state();
    return {
      target: 'sensor-pantai',
      breakerState: state,
      stale: state !== 'closed',
      lastSuccessAt: this.lastSuccessAt,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.opts.coordinator.runAsLeader(LEADER_NAMES.pantai, async ({ fence, signal }) => {
      while (!signal.aborted && !this.stopped) {
        try {
          await this.pollOnce(fence, signal);
        } catch {
          // Errors are classified & metered inside pollOnce; loop continues until leadership is lost
        }
        if (signal.aborted || this.stopped) break;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.pollIntervalMs);
          signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
      }
    });
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Executes a single fenced poll cycle:
   * 1. Ensures station catalog is loaded from /v1/stations
   * 2. Reads cursor from Coordinator
   * 3. Fetches /v1/observations?cursor=... through Bulkhead + CircuitBreaker + retryWithBackoff
   * 4. Guards raw response bytes via Parker.guard
   * 5. Validates each item: valid -> StorageClient.upsertEvent (+ critical fast path), invalid -> Parker.park(CONTRACT_VIOLATION)
   * 6. Commits cursor CAS ONLY after all items in the batch are stored or parked
   */
  async pollOnce(fence: FenceToken, signal?: AbortSignal): Promise<{ accepted: number; quarantined: number; duplicates: number }> {
    if (this.stations.size === 0) {
      await this.refreshStations(fence);
    }

    const { state: cursorState, version: cursorVersion } = await this.opts.coordinator.readCursor<string | null>(LEADER_NAMES.pantai);
    const cursor = cursorState?.position ?? null;
    let floorIso = cursorState?.last_ingested_at ?? null;

    const url = new URL('/v1/observations', this.opts.baseUrl);
    if (cursor) url.searchParams.set('cursor', cursor);
    url.searchParams.set('limit', '100');

    const pollCorrelationId = randomUUID();
    const detectedAtIso = new Date(this.clock()).toISOString();

    const rawBytes = await this.fetchProtectedBytes(url.toString(), signal);
    const guardRes = this.opts.parker.guard(rawBytes);

    const writeCtxBase: Omit<WriteCtx, 'idempotencyKey'> = {
      fence,
      correlationId: pollCorrelationId,
      fenceName: LEADER_NAMES.pantai,
    };

    if (!guardRes.ok) {
      await this.opts.parker.park(
        {
          source: 'SENSOR_PANTAI',
          raw: rawBytes,
          reason_code: guardRes.reason_code,
          detail: guardRes.detail,
          correlationId: pollCorrelationId,
        },
        { ...writeCtxBase, idempotencyKey: `park-batch-${pollCorrelationId}` },
      );
      incCounter(METRICS.ingestEvents, { source: 'SENSOR_PANTAI', outcome: 'quarantined' });
      return { accepted: 0, quarantined: 1, duplicates: 0 };
    }

    const body = guardRes.json as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || !Array.isArray(body['items'])) {
      await this.opts.parker.park(
        {
          source: 'SENSOR_PANTAI',
          raw: rawBytes,
          reason_code: 'CONTRACT_VIOLATION',
          detail: 'invalid_envelope: response missing items array',
          correlationId: pollCorrelationId,
        },
        { ...writeCtxBase, idempotencyKey: `park-env-${pollCorrelationId}` },
      );
      incCounter(METRICS.ingestEvents, { source: 'SENSOR_PANTAI', outcome: 'quarantined' });
      return { accepted: 0, quarantined: 1, duplicates: 0 };
    }

    const generatedAtIso = typeof body['generated_at'] === 'string' ? body['generated_at'] : detectedAtIso;
    const items = body['items'] as unknown[];
    const nextCursor = typeof body['next_cursor'] === 'string' ? body['next_cursor'] : cursor;

    let accepted = 0;
    let quarantined = 0;
    let duplicates = 0;

    for (const item of items) {
      if (signal?.aborted) break;

      const v = validatePantaiObservation(
        item,
        generatedAtIso,
        this.stations,
        this.seenFingerprints,
        { maxStalenessSeconds: this.maxStalenessSeconds },
      );

      if (v.status === 'duplicate') {
        duplicates++;
        incCounter(METRICS.ingestEvents, { source: 'SENSOR_PANTAI', outcome: 'dedup' });
        continue;
      }

      if (v.status === 'violation') {
        const itemBytes = new Uint8Array(Buffer.from(JSON.stringify(item), 'utf8'));
        await this.opts.parker.park(
          {
            source: 'SENSOR_PANTAI',
            raw: itemBytes,
            reason_code: 'CONTRACT_VIOLATION',
            detail: v.detail,
            orderingKey: v.orderingKey,
            correlationId: pollCorrelationId,
          },
          { ...writeCtxBase, idempotencyKey: `park-${v.orderingKey ?? randomUUID()}` },
        );
        quarantined++;
        incCounter(METRICS.ingestEvents, { source: 'SENSOR_PANTAI', outcome: 'quarantined' });
        continue;
      }

      const obs = v.observation;
      const station = this.stations.get(obs.station_id)!;
      const ingestedAt = nextIngestedAt(this.clock(), floorIso);
      floorIso = ingestedAt;

      const event = mapCoastalObservation(obs, station, ingestedAt);
      const priority = obs.critical ? 'critical' : 'normal';
      const upsertRes = await this.opts.storage.upsertEvent(event, {
        ...writeCtxBase,
        idempotencyKey: `${event.hazard_id}:1`,
        outbox: { mode: 'on_create', priority },
      });

      this.seenFingerprints.set(obs.observation_id, v.fingerprint);
      accepted++;
      incCounter(METRICS.ingestEvents, {
        source: 'SENSOR_PANTAI',
        outcome: upsertRes.created ? 'accepted' : 'dedup',
      });

      // Fast path for critical coastal alerts (P5-K1: p95 <= 5s, 0 lost)
      if (obs.critical && upsertRes.created && this.opts.criticalPublisher) {
        const alertMsg: CriticalAlertMessage = {
          message_id: outboxMessageId(event.hazard_id, event.version),
          hazard_id: event.hazard_id,
          source: 'SENSOR_PANTAI',
          severity: event.severity,
          area_name: event.area_name,
          occurred_at: event.occurred_at,
          detected_at: detectedAtIso,
          correlation_id: pollCorrelationId,
        };
        try {
          await this.opts.criticalPublisher.publishCriticalAlert(alertMsg);
        } catch {
          // Outbox row is already persisted in StorageClient and will be retried by OutboxDispatcher!
        }
      }
    }

    if (!signal?.aborted) {
      await this.opts.coordinator.commitCursor(
        LEADER_NAMES.pantai,
        cursorVersion,
        {
          position: nextCursor,
          last_ingested_at: floorIso,
          updated_by: this.opts.instanceId,
        },
        fence,
      );
      this.lastSuccessAt = detectedAtIso;
    }

    return { accepted, quarantined, duplicates };
  }

  async refreshStations(fence?: FenceToken): Promise<void> {
    const url = new URL('/v1/stations', this.opts.baseUrl).toString();
    const rawBytes = await this.fetchProtectedBytes(url);
    const guardRes = this.opts.parker.guard(rawBytes);
    if (!guardRes.ok) {
      throw new Error(`Invalid /v1/stations payload: ${guardRes.reason_code}`);
    }
    const body = guardRes.json as { items?: PantaiStation[] } | PantaiStation[];
    const list = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [];
    for (const st of list) {
      if (st && typeof st.station_id === 'string') {
        this.stations.set(st.station_id, st);
      }
    }
    void fence;
  }

  public setStationsForTest(stations: PantaiStation[]): void {
    this.stations.clear();
    for (const s of stations) this.stations.set(s.station_id, s);
  }

  private async fetchProtectedBytes(url: string, outerSignal?: AbortSignal): Promise<Uint8Array> {
    return this.bulkhead.exec(() =>
      this.breaker.exec((breakerSignal) =>
        retryWithBackoff(
          async () => {
            if (outerSignal?.aborted) throw new Error('Aborted');
            const response = await instrumentOutbound('sensor-pantai', (traceHeaders) =>
              this.fetchFn(url, {
                headers: {
                  ...traceHeaders,
                  Authorization: `Bearer ${this.opts.authToken}`,
                  'X-Aggregator-Instance': this.opts.instanceId,
                },
                signal: breakerSignal,
              }),
            );
            if (!response.ok) {
              const err = new Error(`sensor-pantai HTTP ${response.status}`);
              (err as unknown as Record<string, unknown>)['status'] = response.status;
              throw err;
            }
            const buf = await response.arrayBuffer();
            return new Uint8Array(buf);
          },
          {
            maxAttempts: 2,
            baseMs: 50,
            maxMs: 250,
            jitter: 'full',
          },
        ),
      ),
    );
  }
}
