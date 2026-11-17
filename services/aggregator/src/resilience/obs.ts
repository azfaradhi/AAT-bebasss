/**
 * @bnpb/obs-kit — Shared Observability Helper (CONTRACT-MEMBER-3.md §2)
 * Provides:
 *  - W3C Trace Context (`traceparent`) generation, extraction, AsyncLocalStorage propagation, and OTLP/HTTP export
 *  - Prometheus text-format v0.0.4 metrics registry (counters, gauges, histograms) for all contract METRICS
 *  - Fastify `registerHttpMetrics(app, serviceName)` (exposes /metrics and /ready, records RED server metrics & trace context)
 *  - `instrumentOutbound(target, fn)` (propagates traceparent + x-correlation-id, records RED client metrics + latency_ms)
 *  - `amqpInject` / `amqpExtract` (propagates traceparent + x-correlation-id over RabbitMQ headers)
 *  - `loggerMixin()` (injects trace_id, span_id, correlation_id, instance, node into Pino JSON logs)
 *
 * Zero external npm dependencies beyond Node.js built-ins so `make obs-vendor` works in every service without changing package.json.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const METRICS = {
  httpServerDuration: 'bnpb_http_server_request_duration_seconds',
  httpClientDuration: 'bnpb_http_client_request_duration_seconds',
  ingestEvents: 'bnpb_ingest_events_total',
  parked: 'bnpb_parked_messages',
  partialResponses: 'bnpb_partial_responses_total',
  leader: 'bnpb_leader',
  fencingRejections: 'bnpb_fencing_rejections_total',
  unitUp: 'bnpb_storage_unit_up',
  ringEpoch: 'bnpb_ring_epoch',
  unitKeys: 'bnpb_unit_keys',
  unitWrites: 'bnpb_unit_writes_total',
  breakerState: 'bnpb_breaker_state',
  shed: 'bnpb_shed_total',
  outboxPending: 'bnpb_outbox_pending',
  satOffsetLag: 'bnpb_sat_offset_lag',
  satLateApplied: 'bnpb_sat_late_applied_total',
  satLateBeyond: 'bnpb_sat_late_beyond_bound_total',
  satEventToStore: 'bnpb_sat_event_to_store_seconds',
  criticalE2E: 'bnpb_critical_e2e_seconds',
  criticalTotal: 'bnpb_critical_total',
  fieldReports: 'bnpb_field_reports_total',
} as const;

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  correlationId: string;
}

interface RecordedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  serviceName: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number | boolean>;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();
let currentServiceName = process.env['SERVICE_NAME'] ?? 'bnpb-service';
const spanBuffer: RecordedSpan[] = [];
let flushTimer: NodeJS.Timeout | null = null;

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export function parseTraceparent(header?: string | null): { traceId: string; parentSpanId: string } | null {
  if (!header || typeof header !== 'string') return null;
  const parts = header.trim().split('-');
  if (parts.length !== 4) return null;
  const [version, traceId, parentSpanId] = parts;
  if (version !== '00' || !/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(parentSpanId)) {
    return null;
  }
  if (/^0+$/.test(traceId) || /^0+$/.test(parentSpanId)) return null;
  return { traceId, parentSpanId };
}

export function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

export function getActiveTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

export function runWithTraceContext<T>(ctx: TraceContext, fn: () => T): T {
  return traceStorage.run(ctx, fn);
}

async function flushSpans(): Promise<void> {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (!endpoint || spanBuffer.length === 0) {
    spanBuffer.length = 0;
    return;
  }
  const batch = spanBuffer.splice(0, spanBuffer.length);
  const url = endpoint.replace(/\/$/, '') + '/v1/traces';
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: currentServiceName } },
            { key: 'k8s.pod.name', value: { stringValue: process.env['POD_NAME'] ?? process.env['HOSTNAME'] ?? 'local' } },
            { key: 'k8s.node.name', value: { stringValue: process.env['NODE_NAME'] ?? 'local-node' } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: '@bnpb/obs-kit', version: '1.0.0' },
            spans: batch.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              parentSpanId: s.parentSpanId,
              name: s.name,
              kind: 1,
              startTimeUnixNano: s.startTimeUnixNano,
              endTimeUnixNano: s.endTimeUnixNano,
              attributes: Object.entries(s.attributes).map(([k, v]) => ({
                key: k,
                value: typeof v === 'number' ? { doubleValue: v } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) },
              })),
            })),
          },
        ],
      },
    ],
  };
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Non-fatal when collector is unreachable in unit tests
  }
}

function recordSpan(
  name: string,
  ctx: TraceContext,
  startMs: number,
  endMs: number,
  attributes: Record<string, string | number | boolean>,
): void {
  spanBuffer.push({
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: ctx.parentSpanId,
    name,
    serviceName: currentServiceName,
    startTimeUnixNano: String(BigInt(Math.round(startMs * 1_000_000))),
    endTimeUnixNano: String(BigInt(Math.round(endMs * 1_000_000))),
    attributes,
  });
  if (spanBuffer.length >= 64) {
    void flushSpans();
  }
}

export function initTracing(serviceName: string): { shutdown(): Promise<void> } {
  currentServiceName = serviceName;
  if (!flushTimer && process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) {
    flushTimer = setInterval(() => {
      void flushSpans();
    }, 2000);
    flushTimer.unref();
  }
  return {
    async shutdown(): Promise<void> {
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      await flushSpans();
    },
  };
}

/* ───────────────────────── Prometheus Registry ───────────────────────── */
type Labels = Record<string, string | number>;

function serializeLabels(labels?: Labels): string {
  if (!labels) return '';
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return '';
  return '{' + entries.map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',') + '}';
}

const counters = new Map<string, Map<string, number>>();
const gauges = new Map<string, Map<string, number>>();
const histograms = new Map<
  string,
  {
    buckets: number[];
    series: Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>;
  }
>();

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function incCounter(name: string, labels: Labels = {}, delta = 1): void {
  let m = counters.get(name);
  if (!m) {
    m = new Map();
    counters.set(name, m);
  }
  const key = serializeLabels(labels);
  m.set(key, (m.get(key) ?? 0) + delta);
}

export function setGauge(name: string, labels: Labels = {}, value: number): void {
  let m = gauges.get(name);
  if (!m) {
    m = new Map();
    gauges.set(name, m);
  }
  const key = serializeLabels(labels);
  m.set(key, value);
}

export function observeHistogram(name: string, labels: Labels = {}, valueSeconds: number, buckets = DEFAULT_BUCKETS): void {
  let h = histograms.get(name);
  if (!h) {
    h = { buckets: [...buckets].sort((a, b) => a - b), series: new Map() };
    histograms.set(name, h);
  }
  const key = serializeLabels(labels);
  let s = h.series.get(key);
  if (!s) {
    s = { labels: { ...labels }, counts: new Array(h.buckets.length).fill(0), sum: 0, count: 0 };
    h.series.set(key, s);
  }
  for (let i = 0; i < h.buckets.length; i++) {
    if (valueSeconds <= h.buckets[i]) {
      s.counts[i] += 1;
    }
  }
  s.sum += valueSeconds;
  s.count += 1;
}

export function renderPrometheusMetrics(): string {
  const lines: string[] = [];

  for (const [name, series] of counters) {
    lines.push(`# TYPE ${name} counter`);
    for (const [labelStr, val] of series) {
      lines.push(`${name}${labelStr} ${val}`);
    }
  }

  for (const [name, series] of gauges) {
    lines.push(`# TYPE ${name} gauge`);
    for (const [labelStr, val] of series) {
      lines.push(`${name}${labelStr} ${val}`);
    }
  }

  for (const [name, h] of histograms) {
    lines.push(`# TYPE ${name} histogram`);
    for (const [labelStr, s] of h.series) {
      for (let i = 0; i < h.buckets.length; i++) {
        const bLabels = serializeLabels({ ...s.labels, le: String(h.buckets[i]) });
        lines.push(`${name}_bucket${bLabels} ${s.counts[i]}`);
      }
      const infLabels = serializeLabels({ ...s.labels, le: '+Inf' });
      lines.push(`${name}_bucket${infLabels} ${s.count}`);
      lines.push(`${name}_sum${labelStr} ${s.sum}`);
      lines.push(`${name}_count${labelStr} ${s.count}`);
    }
  }

  return lines.join('\n') + '\n';
}

export function resetMetricsForTest(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
}

/* ───────────────────────── Fastify HTTP Instrumentation ───────────────────────── */
export function registerHttpMetrics(
  app: FastifyInstance,
  serviceName: string,
  readinessCheck?: () => Promise<boolean> | boolean,
): void {
  currentServiceName = serviceName;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const incomingTp = request.headers['traceparent'];
    const parsedTp = typeof incomingTp === 'string' ? parseTraceparent(incomingTp) : null;
    const incomingCorr = request.headers['x-correlation-id'];
    const correlationId =
      typeof incomingCorr === 'string' && incomingCorr.length > 0 ? incomingCorr : randomUUID();

    const traceId = parsedTp?.traceId ?? randomHex(16);
    const spanId = randomHex(8);
    const ctx: TraceContext = {
      traceId,
      spanId,
      parentSpanId: parsedTp?.parentSpanId,
      correlationId,
    };

    (request as unknown as Record<string, unknown>)['__traceCtx'] = ctx;
    (request as unknown as Record<string, unknown>)['__startMs'] = performance.now();
    reply.header('x-correlation-id', correlationId);
    reply.header('traceparent', formatTraceparent(traceId, spanId));

    traceStorage.enterWith(ctx);
  });

  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const startMs = ((request as unknown as Record<string, unknown>)['__startMs'] as number | undefined) ?? performance.now();
    const durationSec = Math.max(0, (performance.now() - startMs) / 1000);
    const route = request.routeOptions?.url ?? request.url.split('?')[0] ?? 'unknown';
    const method = request.method;
    const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;

    observeHistogram(METRICS.httpServerDuration, {
      service: serviceName,
      route,
      method,
      status_class: statusClass,
    }, durationSec);

    const ctx = (request as unknown as Record<string, unknown>)['__traceCtx'] as TraceContext | undefined;
    if (ctx) {
      recordSpan(`${method} ${route}`, ctx, Date.now() - durationSec * 1000, Date.now(), {
        'http.method': method,
        'http.route': route,
        'http.status_code': reply.statusCode,
        'correlation_id': ctx.correlationId,
      });
    }
  });

  app.get('/metrics', async (_request, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return reply.send(renderPrometheusMetrics());
  });

  app.get('/ready', async (_request, reply) => {
    if (readinessCheck) {
      const ok = await readinessCheck();
      if (!ok) {
        return reply.status(503).send({ status: 'not_ready', service: serviceName });
      }
    }
    return reply.status(200).send({ status: 'ready', service: serviceName });
  });
}

/* ───────────────────────── Outbound HTTP & AMQP Propagation ───────────────────────── */
export async function instrumentOutbound<T>(
  target: string,
  fn: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  const parent = traceStorage.getStore();
  const traceId = parent?.traceId ?? randomHex(16);
  const spanId = randomHex(8);
  const correlationId = parent?.correlationId ?? randomHex(8);
  const childCtx: TraceContext = {
    traceId,
    spanId,
    parentSpanId: parent?.spanId,
    correlationId,
  };

  const headers: Record<string, string> = {
    traceparent: formatTraceparent(traceId, spanId),
    'x-correlation-id': correlationId,
  };

  const startMs = performance.now();
  const wallStart = Date.now();
  let statusClass = '2xx';
  try {
    const res = await traceStorage.run(childCtx, () => fn(headers));
    if (res && typeof res === 'object' && 'status' in (res as Record<string, unknown>)) {
      const st = Number((res as Record<string, unknown>)['status']);
      if (Number.isFinite(st) && st >= 100) {
        statusClass = `${Math.floor(st / 100)}xx`;
      }
    }
    return res;
  } catch (err) {
    statusClass = 'error';
    throw err;
  } finally {
    const durationSec = Math.max(0, (performance.now() - startMs) / 1000);
    observeHistogram(METRICS.httpClientDuration, {
      service: currentServiceName,
      target,
      status_class: statusClass,
    }, durationSec);
    recordSpan(`outbound:${target}`, childCtx, wallStart, Date.now(), {
      'peer.service': target,
      'status_class': statusClass,
      'latency_ms': Math.round(durationSec * 1000),
    });
  }
}

export function amqpInject(headers?: Record<string, unknown>): Record<string, unknown> {
  const ctx = traceStorage.getStore();
  const traceId = ctx?.traceId ?? randomHex(16);
  const spanId = randomHex(8);
  const correlationId = ctx?.correlationId ?? randomHex(8);
  return {
    ...(headers ?? {}),
    traceparent: formatTraceparent(traceId, spanId),
    'x-correlation-id': correlationId,
  };
}

export async function amqpExtract<T>(
  headers: Record<string, unknown> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const rawTp = headers?.['traceparent'];
  const parsed = typeof rawTp === 'string' ? parseTraceparent(rawTp) : null;
  const rawCorr = headers?.['x-correlation-id'];
  const correlationId = typeof rawCorr === 'string' && rawCorr.length > 0 ? rawCorr : randomHex(8);

  const ctx: TraceContext = {
    traceId: parsed?.traceId ?? randomHex(16),
    spanId: randomHex(8),
    parentSpanId: parsed?.parentSpanId,
    correlationId,
  };

  const wallStart = Date.now();
  try {
    return await traceStorage.run(ctx, fn);
  } finally {
    recordSpan('amqp.consume', ctx, wallStart, Date.now(), {
      'messaging.system': 'rabbitmq',
      'correlation_id': correlationId,
    });
  }
}

export function loggerMixin(): () => Record<string, string | undefined> {
  const instance = process.env['POD_NAME'] ?? process.env['HOSTNAME'] ?? 'local';
  const node = process.env['NODE_NAME'] ?? 'local-node';
  return () => {
    const ctx = traceStorage.getStore();
    return {
      instance,
      node,
      trace_id: ctx?.traceId,
      span_id: ctx?.spanId,
      correlation_id: ctx?.correlationId,
    };
  };
}
