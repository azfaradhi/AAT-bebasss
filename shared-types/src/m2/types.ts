/**
 * M2 CONTRACT — shared types and interfaces (single source of truth for signatures).
 * Version: see ../README.md. Change only through the contract change protocol.
 * Pure types: no runtime logic here (runtime helpers live in ids.ts).
 *
 */

/* ───────────────────────── Domain enums (CHG-1/2) ───────────────────────── */
export type HazardSource = 'BMKG' | 'PVMBG' | 'SATELIT' | 'SENSOR_PANTAI';
export type HazardType = 'SEISMIC' | 'VOLCANIC' | 'WILDFIRE' | 'COASTAL';
export type Severity = 'NORMAL' | 'WASPADA' | 'SIAGA' | 'AWAS';
export type IdentityClass = 'lapangan' | 'internal' | 'media';

/** Lampiran A field names, exactly. `ingested_at` is immutable after first insert (C-TIME). */
export interface HazardEvent {
  hazard_id: string; // C-ID: "hz-" + sha256(source|source_ref_id)[0..12]
  source: HazardSource;
  source_ref_id: string;
  hazard_type: HazardType;
  severity: Severity;
  area_name: string;
  latitude: number;
  longitude: number;
  occurred_at: string; // ISO-8601 UTC
  ingested_at: string; // ISO-8601 UTC, immutable
  attributes: Record<string, unknown>;
}

/** What is stored. `version` is internal only (never returned by Audit API). */
export interface StoredHazardEvent extends HazardEvent {
  version: number; // LWW key. SATELIT: the stream offset that produced this state. Others: 1.
}

/* ───────────────────────── Paging, partial results ───────────────────────── */
export interface Page<T> {
  items: T[];
  next_cursor: string | null; // opaque; see ids.ts encodeCursor/decodeCursor
  partial: boolean;
  unavailable_units: string[];
}

/** A read that could not reach part of the data. Never convert this to HTTP 500. */
export interface PartialInfo {
  partial: boolean;
  unavailable_units: string[];
}

/* ───────────────────────── Fencing / coordination ───────────────────────── */
/** Strictly increasing across leadership changes of the same name. */
export type FenceToken = number;

export interface WriteCtx {
  fence: FenceToken;
  /** Deterministic key for the logical write (e.g. hazard_id+version, message_id, report_id). */
  idempotencyKey: string;
  correlationId: string;
  /** Name the fence token belongs to ('bmkg' | 'pvmbg' | 'satellite' | 'pantai' | 'field-reports' | 'ingest'). */
  fenceName: string;
  /** Outbox behaviour for event writes. Default { mode: 'on_create' }. */
  outbox?: { mode: 'on_create' | 'on_apply' | 'never'; priority?: 'critical' | 'normal' };
}

export interface CursorState<T = unknown> {
  position: T; // source-specific (since-timestamp, stream offset, observation cursor…)
  /** Floor for ingested_at assignment (C-TIME). New leader uses max(now, floor+1ms). */
  last_ingested_at: string | null;
  updated_by: string; // pod name
}

export interface Coordinator {
  /**
   * Run `fn` only while this instance is leader for `name`. Re-enters automatically on re-election.
   * `ctx.signal` aborts when leadership is lost OR becomes uncertain (missed renew deadline).
   * Resolves only after `stop()`.
   */
  runAsLeader(name: string, fn: (ctx: { fence: FenceToken; signal: AbortSignal }) => Promise<void>): Promise<void>;
  isLeader(name: string): boolean;
  currentFence(name: string): FenceToken | null;
  readCursor<T>(name: string): Promise<{ state: CursorState<T> | null; version: string }>;
  /** Compare-and-swap. Returns false if `expectedVersion` is stale OR `fence` is not the latest for `name`. */
  commitCursor<T>(name: string, expectedVersion: string, next: CursorState<T>, fence: FenceToken): Promise<boolean>;
  stop(): Promise<void>;
}

/* ───────────────────────── Storage ───────────────────────── */
export type Collection = 'parked' | 'field_reports' | 'fire_state';

export interface UpsertResult {
  created: boolean;
  /** false when `version` <= stored version (idempotent no-op / stale write). */
  applied: boolean;
  replicas_acked: number;
  replicas_target: number;
}

export interface OutboxItem {
  message_id: string; // deterministic: "ob-" + hazard_id + ":" + version
  hazard_id: string;
  event: StoredHazardEvent;
  priority: 'critical' | 'normal';
  correlation_id: string;
  attempts: number;
  traceparent?: string;
}

/** Time axis and range are on `occurred_at` (the historical dataset is all ingested at one instant, so ingested_at would be one spike). */
export interface AggQuery {
  from?: string; // ISO, occurred_at >= from
  to?: string; // ISO, occurred_at < to
  bucket: 'hour' | 'day';
}
export interface AggResult {
  by_type_over_time: Array<{
    bucket: string; // ISO start
    gempa: number;
    tsunami: number;
    gunung_berapi: number;
    kebakaran_hutan: number;
    pesisir: number;
  }>;
  by_severity: Record<Severity, number>;
  by_area: Array<{ area_name: string; count: number }>;
  total: number;
}

export interface LocationInfo {
  node: string; // as in `kubectl get nodes`
  unit: string;
  role: 'primary' | 'replica';
}

export type UnitState = 'STABLE' | 'JOINING' | 'RECOVERING' | 'DOWN';
export interface RingStatus {
  epoch: number;
  rf: number;
  units: Array<{ unit: string; node: string; state: UnitState; keys: number; writes_total: number }>;
  redundancy_ok: boolean; // every key has >= rf healthy, synced replicas
  repairing: boolean;
  as_of: string;
}

export interface StorageClient {
  /** Idempotent by hazard_id; last-writer-wins by `version`; `ingested_at` of an existing record is never changed. Fenced. */
  upsertEvent(e: StoredHazardEvent, ctx: WriteCtx): Promise<UpsertResult>;
  /** Soft-delete (superseded/retracted fire). Excluded from list/aggregate/checksum/audit afterwards. LWW by `version`. */
  tombstoneEvent(hazardId: string, version: number, ctx: WriteCtx, mergedInto?: string): Promise<{ applied: boolean }>;
  getEvent(hazardId: string): Promise<{ event: HazardEvent | null } & PartialInfo>;
  /** Order: ingested_at asc, then hazard_id (byte order). `since` filters ingested_at >= since. Tombstones excluded. */
  listEvents(q: { source?: HazardSource; hazardType?: HazardType; since?: string; limit: number; cursor?: string }): Promise<Page<HazardEvent>>;
  aggregate(q: AggQuery): Promise<AggResult & PartialInfo>;
  /** Lampiran A algorithm. Tombstones excluded. */
  checksum(source: HazardSource): Promise<{ count: number; checksum: string; as_of: string } & PartialInfo>;
  locate(hazardId: string): Promise<{ locations: LocationInfo[] } & PartialInfo>; // [] when unknown

  /** Generic documents. LWW by optional `version` (omit = overwrite). Fenced. */
  putDoc(c: Collection, key: string, doc: unknown, ctx: WriteCtx, opts?: { version?: number }): Promise<void>;
  getDoc<T>(c: Collection, key: string): Promise<T | null>;
  listDocs<T>(c: Collection, q: { prefix?: string; limit: number; cursor?: string }): Promise<Page<{ key: string; doc: T }>>;
  deleteDoc(c: Collection, key: string, ctx: WriteCtx): Promise<void>;

  /** Outbox rows live in the same unit/transaction as the primary event row (R6). */
  claimOutbox(max: number, leaseMs: number): Promise<OutboxItem[]>;
  markOutboxPublished(messageIds: string[]): Promise<void>;
  outboxPending(): Promise<number>;

  /** Raise the fence for `name` on a write quorum. Writes with a lower token are rejected afterwards. */
  fenceBarrier(name: string, token: FenceToken): Promise<void>;
  ringStatus(): Promise<RingStatus>;
}

/* ───────────────────────── Errors (typed; handlers map them) ───────────────────────── */
export class FencedError extends Error {
  readonly code = 'FENCED';
  constructor(public readonly fenceName: string, public readonly got: FenceToken, public readonly current: FenceToken) {
    super(`fenced: ${fenceName} token ${got} < ${current}`);
  }
}
/** Not enough units to honour a *write*. Reads degrade to partial instead of throwing. */
export class StorageUnavailableError extends Error {
  readonly code = 'STORAGE_UNAVAILABLE';
  constructor(public readonly unavailable_units: string[]) {
    super(`storage unavailable: ${unavailable_units.join(',')}`);
  }
}
export class BreakerOpenError extends Error {
  readonly code = 'BREAKER_OPEN';
  constructor(public readonly target: string) {
    super(`breaker open: ${target}`);
  }
}
export class BulkheadFullError extends Error {
  readonly code = 'BULKHEAD_FULL';
  constructor(public readonly target: string) {
    super(`bulkhead full: ${target}`);
  }
}

/* ───────────────────────── Parking / unprocessed (P3, P5-K2) ───────────────────────── */
export type RetryableReason = 'DOWNSTREAM_UNAVAILABLE' | 'STORAGE_PARTIAL' | 'TIMEOUT' | 'BROKER_UNAVAILABLE' | 'RATE_LIMITED';
export type PermanentReason =
  | 'SCHEMA_INCOMPATIBLE' | 'MALFORMED_JSON' | 'INVALID_UTF8' | 'PAYLOAD_TOO_LARGE' | 'NESTING_TOO_DEEP'
  | 'CONTRACT_VIOLATION' | 'UNKNOWN_ENUM_VALUE' | 'MAPPING_ERROR';
export type ReasonCode = RetryableReason | PermanentReason | 'RETRIES_EXHAUSTED';
export type ParkStatus = 'retrying' | 'parked' | 'recovered';
export type ParkSource = HazardSource | 'FIELD_REPORT';

export interface ParkedMessage {
  message_id: string; // "msg-" + sha256(source|raw)[0..12] → same bytes parked twice = same record
  source: ParkSource;
  received_at: string;
  first_failed_at: string;
  last_attempt_at: string;
  next_attempt_at: string | null; // set while status='retrying'
  reason_code: ReasonCode;
  reason: string; // `${reason_code.toLowerCase()}: ${detail}`  (Lampiran A example style)
  retryable: boolean;
  attempts: number;
  status: ParkStatus;
  raw_b64: string; // intact bytes up to MAX_PARK_RAW_BYTES; else truncated (raw_truncated=true) + sha256 always present
  raw_truncated: boolean;
  raw_sha256: string;
  raw_size: number;
  ordering_key?: string; // source_ref_id when parseable → replay sequential per key
  recovered_at?: string;
}

export interface GuardLimits { maxBytes: number; maxDepth: number }
export type GuardResult =
  | { ok: true; json: unknown }
  | { ok: false; reason_code: Extract<ReasonCode, 'MALFORMED_JSON' | 'INVALID_UTF8' | 'PAYLOAD_TOO_LARGE' | 'NESTING_TOO_DEEP'>; detail: string };

export interface ReplayReport {
  considered: number;
  recovered: number;
  still_failing: number;
  skipped_already_recovered: number;
  per_key_order_violations: 0; // by construction; present so tests can assert it
}

export interface Parker {
  /** Pure + synchronous. Size check → strict UTF-8 → depth check → JSON.parse, in that order. Never throws. */
  guard(raw: Uint8Array, limits?: Partial<GuardLimits>): GuardResult;
  /** Idempotent: same (source, raw) → same record (attempts/status updated, not duplicated). */
  park(m: {
    source: ParkSource; raw: Uint8Array; reason_code: ReasonCode; detail: string;
    orderingKey?: string; correlationId?: string; retryAfterMs?: number;
  }, ctx: WriteCtx): Promise<ParkedMessage>;
  listUnprocessed(q: { source?: ParkSource; limit: number; cursor?: string }): Promise<Page<ParkedMessage>>; // retrying|parked only
  get(messageId: string): Promise<ParkedMessage | null>;
  /** Re-run `handler` for each matching parked message: sequential per ordering_key (arrival order), parallel across keys. Idempotent. */
  replay(
    q: { reason_code?: ReasonCode; source?: ParkSource; includeRetryable?: boolean },
    handler: (raw: Uint8Array, meta: ParkedMessage) => Promise<void>,
    ctx: WriteCtx,
  ): Promise<ReplayReport>;
}

/* ───────────────────────── Resilience primitives (Member 3 owns the implementation) ───────────────────────── */
export type BreakerState = 'closed' | 'half_open' | 'open';
export interface CircuitBreaker {
  readonly target: string;
  state(): BreakerState;
  /** Throws BreakerOpenError immediately when open (no call is made). */
  exec<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
export interface Bulkhead {
  readonly target: string;
  exec<T>(fn: () => Promise<T>): Promise<T>; // throws BulkheadFullError when queue is full
}
export interface RetryOptions { maxAttempts: number; baseMs: number; maxMs: number; jitter: 'full'; isRetryable?: (e: unknown) => boolean }
export type AdmissionDecision = { admitted: true; release: () => void } | { admitted: false; retryAfterSeconds: number; identity: IdentityClass };
export interface AdmissionController {
  admit(identity: IdentityClass, correlationId?: string): AdmissionDecision;
}

/* ───────────────────────── Satellite feed (observed from the real feed, practice profile) ───────────────────────── */
export interface Detection {
  version: string;
  scan: number;
  acq_date: string; // YYYY-MM-DD
  acq_time: number; // integer HHMM WITHOUT leading zeros (e.g. 6 = 00:06, 2353 = 23:53)
  bright_ti4: number;
  bright_ti5: number;
  confidence: 'l' | 'n' | 'h';
  daynight: 'D' | 'N';
  frp: number; // MW
  instrument: 'VIIRS';
  latitude: number;
  longitude: number;
  satellite: string; // 'N' | 'N20' | 'N21' | …
  track: number;
}
export type FeedEvent =
  | { kind: 'detection'; offset: number; detection: Detection }
  | { kind: 'update'; offset: number; key: string; changes: Partial<Detection> }
  | { kind: 'retract'; offset: number; key: string; reason: string }
  | { kind: 'heartbeat'; offset?: number; raw?: unknown };
// Offsets are one shared monotonic, gap-free sequence across ALL kinds. SSE `id:` == offset.

/** Output of fire recognition (P4). Internal state shape is Member 1's; this is the cross-member view. */
export interface FireSummary {
  fire_id: string;
  detection_count: number;
  satellites: string[];
  max_confidence: 'l' | 'n' | 'h';
  total_frp_mw: number;
  detection_keys: string[];
  earliest_detection_time: string;
}

/* ───────────────────────── Field reports (P3-K6) ───────────────────────── */
export interface FieldReportRequest {
  category: 'KORBAN' | 'KERUSAKAN' | 'KEBUTUHAN' | 'LAINNYA';
  description: string; // <= 4000 chars
  latitude: number;
  longitude: number;
  observed_at: string;
  hazard_ref?: string;
  attributes?: Record<string, unknown>;
}
export interface FieldReportAccepted { report_id: string; status: 'accepted'; received_at: string }
export interface StoredFieldReport extends FieldReportRequest {
  report_id: string; reporter: string; received_at: string; processed_at: string | null;
}
export interface FieldReportAudit {
  accepted_total: number; processed_total: number; duplicates_dropped_total: number; items: string[];
  partial: boolean; unavailable_units: string[];
}

/* ───────────────────────── Sensor Pantai (Lampiran C) ───────────────────────── */
export interface PantaiStation { station_id: string; name: string; province: string; latitude: number; longitude: number }
export interface PantaiObservation {
  observation_id: string; station_id: string; observed_at: string;
  sea_level_anomaly_m: number; wave_height_m: number; quality: string; critical: boolean;
}
export interface PantaiObservations { generated_at: string; items: PantaiObservation[]; next_cursor: string | null }

/* ───────────────────────── Alert path (P5-K1) ───────────────────────── */
/** Message on `critical_alerts_queue`. The notifier acks only after recording the delivery. */
export interface CriticalAlertMessage {
  message_id: string; // = OutboxItem.message_id
  hazard_id: string;
  source: HazardSource;
  severity: Severity;
  area_name: string;
  occurred_at: string; // sensor observed_at → start of the p95 ≤ 5 s clock is `detected_at`
  detected_at: string; // when WE first saw it (poll time); e2e latency histogram starts here
  correlation_id: string;
}
export interface DeliveryRecord { message_id: string; hazard_id: string; delivered_at: string; e2e_seconds: number }

/* ───────────────────────── Audit / ops wire DTOs (Lampiran A) ───────────────────────── */
export interface AuditEventsResponse { items: HazardEvent[]; next_cursor: string | null; partial: boolean; unavailable_units: string[] }
export interface AuditChecksumResponse {
  source: HazardSource; count: number; checksum: string; algorithm: 'sha256'; as_of: string; partial: boolean; unavailable_units: string[];
}
export interface AuditLocationResponse { hazard_id: string; locations: LocationInfo[]; partial: boolean }
export interface AuditUnprocessedItem {
  message_id: string; source: ParkSource; received_at: string; reason: string; retryable: boolean; attempts: number; status: 'retrying' | 'parked';
}
export interface AuditUnprocessedResponse { items: AuditUnprocessedItem[]; next_cursor: string | null }
export interface ErrorEnvelope { error: { code: string; message: string } }

/* ───────────────────────── Metric names (contract §6) ───────────────────────── */
export const METRICS = {
  httpServerDuration: 'bnpb_http_server_request_duration_seconds',
  httpClientDuration: 'bnpb_http_client_request_duration_seconds',
  ingestEvents: 'bnpb_ingest_events_total', // {source,outcome}
  parked: 'bnpb_parked_messages', // gauge {status,reason_code}
  partialResponses: 'bnpb_partial_responses_total', // {endpoint}
  leader: 'bnpb_leader', // gauge {name}
  fencingRejections: 'bnpb_fencing_rejections_total', // {name}
  unitUp: 'bnpb_storage_unit_up', // {unit,node}
  ringEpoch: 'bnpb_ring_epoch',
  unitKeys: 'bnpb_unit_keys', // {unit,node}
  unitWrites: 'bnpb_unit_writes_total', // {unit,node}
  breakerState: 'bnpb_breaker_state', // {target} 0 closed,1 half,2 open
  shed: 'bnpb_shed_total', // {identity_class}
  outboxPending: 'bnpb_outbox_pending',
  satOffsetLag: 'bnpb_sat_offset_lag',
  satLateApplied: 'bnpb_sat_late_applied_total',
  satLateBeyond: 'bnpb_sat_late_beyond_bound_total',
  satEventToStore: 'bnpb_sat_event_to_store_seconds',
  criticalE2E: 'bnpb_critical_e2e_seconds',
  criticalTotal: 'bnpb_critical_total', // {outcome}
  fieldReports: 'bnpb_field_reports_total', // {outcome}
} as const;

/* ───────────────────────── Audit plug-in points (Member 2 owns the router; 1 and 3 supply providers) ───────────────────────── */
export interface AuditProviders {
  /** Member 1. Wraps Parker.listUnprocessed → Lampiran A item shape (retrying|parked only). */
  unprocessed(q: { source?: ParkSource; limit: number; cursor?: string }): Promise<AuditUnprocessedResponse>;
  /** Member 1. Counters + ids of field reports (P3-K6 proof). */
  fieldReports(q: { limit: number; cursor?: string }): Promise<FieldReportAudit & { next_cursor: string | null }>;
  /** Member 3. Deliveries recorded by notifier-lapangan (P5-K1 proof). */
  criticalDeliveries(q: { limit: number; cursor?: string }): Promise<{ items: DeliveryRecord[]; total: number; p95_seconds: number | null; next_cursor: string | null }>;
}

/* ───────────────────────── Broker payloads (Member 3 owns topology, producers own payload content) ───────────────────────── */
/** Message on `field_reports_queue` (quorum, durable). Producer = client-api handler (M1); consumer = field-report-processor (M1). */
export interface FieldReportQueueMessage {
  report_id: string;
  reporter: string; // authenticated identity (client id), never a client-supplied value
  received_at: string;
  correlation_id: string;
  body: FieldReportRequest;
}
/** Names are part of the contract: leader election names double as fence names (WriteCtx.fenceName). */
export const LEADER_NAMES = {
  bmkg: 'bmkg', // Member 2 runs the BMKG poller under this lease
  pvmbg: 'pvmbg', // Member 2
  satellite: 'satellite', // Member 1 (single SSE connection: the feed answers 429 to a 2nd one)
  pantai: 'pantai', // Member 3
  ingestRetry: 'ingest-retry', // Member 1: sweeper that re-attempts status=retrying parked messages
} as const;
export const BROKER = {
  hazardExchange: 'hazard_events_exchange', // fanout, durable (M1 name kept)
  fieldReportsQueue: 'field_reports_queue', // quorum, durable
  criticalAlertsQueue: 'critical_alerts_queue', // quorum, durable; bound with routing key 'critical'
  deadLetterExchange: 'dlx_hazard',
} as const;
export const ROLES = ['aggregator', 'store', 'broker', 'consumer', 'api', 'mock', 'sensor', 'other'] as const;
export type Role = (typeof ROLES)[number];
/** JWT claim contract (auth-service → client-api). `scope` is the identity class; permissions add write rights. */
export interface ClientTokenClaims { sub: string; scope: IdentityClass; permissions: Array<'field-reports:write' | 'ops:read' | 'ops:replay'>; aud: string; exp: number; iat: number }
