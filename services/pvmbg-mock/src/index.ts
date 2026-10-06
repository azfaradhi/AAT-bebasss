import Fastify, { FastifyError } from 'fastify';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

dotenv.config();

const app = Fastify({
  logger: true
});

const PORT = parseInt(process.env.PVMBG_PORT || '8082', 10);
const JWT_SECRET = process.env.PVMBG_JWT_SECRET;
const DELAY_MIN = parseInt(process.env.PVMBG_DELAY_MIN_MS || '500', 10);
const DELAY_MAX = parseInt(process.env.PVMBG_DELAY_MAX_MS || '3000', 10);

if (!JWT_SECRET) throw new Error('PVMBG_JWT_SECRET must be configured');

import { VolcanicReport } from '../../../shared-types/src/volcanic';
import { ErrorEnvelope, HealthResponse } from '../../../shared-types/src/envelopes';

// ErrorEnvelope for every non-2xx response, including Fastify's own default errors.
app.setNotFoundHandler((request, reply) => {
  const err: ErrorEnvelope = { error: { code: 'NOT_FOUND', message: `Route ${request.method}:${request.url} not found` } };
  return reply.code(404).send(err);
});

app.setErrorHandler((error: FastifyError, request, reply) => {
  const statusCode = error.statusCode ?? 500;
  const err: ErrorEnvelope = {
    error: { code: statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST', message: error.message },
  };
  if (statusCode >= 500) app.log.error(error);
  return reply.code(statusCode).send(err);
});

const volcanicReports: VolcanicReport[] = [];
let schemaConfidenceLevelEnabled = false;
let outageActive = false;
let outageTimeout: NodeJS.Timeout | null = null;

app.addHook('onRequest', async (request, reply) => {
  const inbound = request.headers['x-correlation-id'];
  const correlationId = typeof inbound === 'string' && inbound.length > 0 ? inbound : randomUUID();
  reply.header('x-correlation-id', correlationId);
  request.log.info({ correlation_id: correlationId }, 'request received');
});

// The volcano reference table keys, to generate plausible volcano_ids
const volcanoIds = ['v-merapi', 'v-semeru', 'v-kelud', 'v-sinabung', 'v-agung'];

function generateSingleReport(timestamp: Date): VolcanicReport {
  const isAwas = Math.random() > 0.9;
  const alert_level = isAwas ? 'Awas' : (Math.random() > 0.7 ? 'Siaga' : (Math.random() > 0.5 ? 'Waspada' : 'Normal'));

  const report: VolcanicReport = {
    report_id: randomUUID(),
    volcano_id: volcanoIds[Math.floor(Math.random() * volcanoIds.length)],
    alert_level,
    eruption_count_24h: Math.floor(Math.random() * 50),
    ash_column_height_m: isAwas ? Math.floor(1000 + Math.random() * 4000) : Math.floor(Math.random() * 500),
    reported_at: timestamp.toISOString()
  };

  if (schemaConfidenceLevelEnabled) {
    report.confidence_level = parseFloat(Math.random().toFixed(2));
  }

  return report;
}

function generateSeedData() {
  const now = Date.now();
  const ONE_HOUR = 3600000;
  
  for (let i = 0; i < 25; i++) {
    // Spread reported_at over the last 24h
    const reported_at = new Date(now - (24 * ONE_HOUR) + (i * 0.9 * ONE_HOUR));
    volcanicReports.push(generateSingleReport(reported_at));
  }
}

generateSeedData();

// Periodically generate new reports to simulate live data
setInterval(() => {
  volcanicReports.push(generateSingleReport(new Date()));
}, 10000); // every 10 seconds

app.addHook('preHandler', async (request, reply) => {
  if (request.url === '/health' || request.url.startsWith('/admin/')) return;
  
  if (outageActive) {
    // Return 503 immediately
    const err: ErrorEnvelope = { error: { code: 'PVMBG_OUTAGE', message: 'Service unavailable' } };
    return reply.code(503).send(err);
  }

  const delay = Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN + 1)) + DELAY_MIN;
  await new Promise(resolve => setTimeout(resolve, delay));
});

app.addHook('preHandler', async (request, reply) => {
  if (request.url === '/health' || request.url.startsWith('/admin/')) return;

  const bmkgKey = request.headers['x-bmkg-key'] as string | undefined;
  if (bmkgKey) {
    const err: ErrorEnvelope = { error: { code: 'FORBIDDEN', message: 'Cross-domain credential rejected' } };
    return reply.code(403).send(err);
  }

  const authHeader = request.headers['authorization'] as string | undefined;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err: ErrorEnvelope = { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' } };
    return reply.code(401).send(err);
  }

  const token = authHeader.split(' ')[1];
  try {
    jwt.verify(token, JWT_SECRET, { audience: 'pvmbg' });
  } catch (err) {
    const errorEnv: ErrorEnvelope = { error: { code: 'UNAUTHORIZED', message: 'Invalid token' } };
    return reply.code(401).send(errorEnv);
  }
});

app.get('/health', async (request, reply) => {
  const res: HealthResponse = {
    status: outageActive ? 'down' : 'ok',
    service: 'pvmbg-mock',
    timestamp: new Date().toISOString()
  };
  return reply.send(res);
});

app.get('/volcanic-reports', async (request, reply) => {
  const { since } = request.query as { since?: string };
  let data = volcanicReports;
  if (since) {
    const sinceDate = new Date(since).getTime();
    data = data.filter(r => new Date(r.reported_at).getTime() >= sinceDate);
  }
  return { data };
});

app.post('/admin/schema-version', async (request, reply) => {
  const body = request.body as { enabled?: unknown } | undefined;
  if (typeof body?.enabled !== 'boolean') {
    const err: ErrorEnvelope = { error: { code: 'BAD_REQUEST', message: '"enabled" (boolean) is required' } };
    return reply.code(400).send(err);
  }
  schemaConfidenceLevelEnabled = body.enabled;
  return reply.send({ confidence_level_enabled: schemaConfidenceLevelEnabled });
});

app.post('/admin/outage', async (request, reply) => {
  const body = request.body as { enabled?: unknown; duration_seconds?: unknown } | undefined;
  if (typeof body?.enabled !== 'boolean') {
    const err: ErrorEnvelope = { error: { code: 'BAD_REQUEST', message: '"enabled" (boolean) is required' } };
    return reply.code(400).send(err);
  }
  if (body.duration_seconds !== undefined && typeof body.duration_seconds !== 'number') {
    const err: ErrorEnvelope = { error: { code: 'BAD_REQUEST', message: '"duration_seconds", if given, must be a number' } };
    return reply.code(400).send(err);
  }
  const { enabled, duration_seconds } = body as { enabled: boolean; duration_seconds?: number };

  if (outageTimeout) {
    clearTimeout(outageTimeout);
    outageTimeout = null;
  }

  outageActive = enabled;

  if (enabled && duration_seconds) {
    outageTimeout = setTimeout(() => {
      outageActive = false;
      outageTimeout = null;
    }, duration_seconds * 1000);
  }

  return reply.send({ 
    outage_active: outageActive, 
    until: (enabled && duration_seconds) ? new Date(Date.now() + duration_seconds * 1000).toISOString() : null 
  });
});

app.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`pvmbg-mock listening on ${address}`);
});
