import Fastify from 'fastify';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';

dotenv.config();

const app = Fastify({
  logger: true
});

const PORT = parseInt(process.env.BMKG_PORT || '8081', 10);
const API_KEY = process.env.BMKG_API_KEY || 'changeme-bmkg-key';
const DELAY_MIN = parseInt(process.env.BMKG_DELAY_MIN_MS || '50', 10);
const DELAY_MAX = parseInt(process.env.BMKG_DELAY_MAX_MS || '150', 10);

// Shared types (we assume they are available at compile/runtime. In docker we will copy them or use relative paths. For now, since it's a monorepo we can just import relatively)
import { SeismicEvent, TsunamiWarning } from '../../shared-types/src/seismic';
import { ErrorEnvelope, HealthResponse } from '../../shared-types/src/envelopes';

const seismicEvents: SeismicEvent[] = [];
const tsunamiWarnings: TsunamiWarning[] = [];

// Seed generation
function generateSeedData() {
  const now = Date.now();
  const ONE_HOUR = 3600000;
  
  for (let i = 0; i < 25; i++) {
    const event_id = randomUUID();
    const isTsunami = Math.random() > 0.8;
    const magnitude = 4.0 + Math.random() * 4.0; // 4.0 to 8.0
    
    // Spread occurred_at over the last 24h
    const occurred_at = new Date(now - (24 * ONE_HOUR) + (i * 0.9 * ONE_HOUR)).toISOString();
    
    const event: SeismicEvent = {
      event_id,
      magnitude: parseFloat(magnitude.toFixed(1)),
      depth_km: Math.floor(10 + Math.random() * 100),
      epicenter_lat: parseFloat((-10 + Math.random() * 15).toFixed(4)),
      epicenter_lon: parseFloat((95 + Math.random() * 45).toFixed(4)),
      region_name: `Region ${i}`,
      occurred_at,
      potential_tsunami: isTsunami
    };
    seismicEvents.push(event);

    if (isTsunami) {
      let threat_level: 'Waspada' | 'Siaga' | 'Awas' = 'Waspada';
      if (magnitude >= 7.0) threat_level = 'Awas';
      else if (magnitude >= 6.0) threat_level = 'Siaga';

      const warning: TsunamiWarning = {
        warning_id: randomUUID(),
        related_event_id: event_id,
        threat_level,
        affected_zones: [`Zone A-${i}`, `Zone B-${i}`],
        estimated_arrival: new Date(new Date(occurred_at).getTime() + 2 * ONE_HOUR).toISOString()
      };
      tsunamiWarnings.push(warning);
    }
  }
}

generateSeedData();

// Periodically generate new reports to simulate live data
setInterval(() => {
  const event_id = randomUUID();
  const isTsunami = Math.random() > 0.8;
  const magnitude = 4.0 + Math.random() * 4.0;
  const occurred_at = new Date().toISOString();
  
  const event: SeismicEvent = {
    event_id,
    magnitude: parseFloat(magnitude.toFixed(1)),
    depth_km: Math.floor(10 + Math.random() * 100),
    epicenter_lat: parseFloat((-10 + Math.random() * 15).toFixed(4)),
    epicenter_lon: parseFloat((95 + Math.random() * 45).toFixed(4)),
    region_name: `Live Region ${Math.floor(Math.random() * 100)}`,
    occurred_at,
    potential_tsunami: isTsunami
  };
  seismicEvents.push(event);

  if (isTsunami) {
    let threat_level: 'Waspada' | 'Siaga' | 'Awas' = 'Waspada';
    if (magnitude >= 7.0) threat_level = 'Awas';
    else if (magnitude >= 6.0) threat_level = 'Siaga';

    const warning: TsunamiWarning = {
      warning_id: randomUUID(),
      related_event_id: event_id,
      threat_level,
      affected_zones: [`Live Zone A`, `Live Zone B`],
      estimated_arrival: new Date(new Date(occurred_at).getTime() + 2 * 3600000).toISOString()
    };
    tsunamiWarnings.push(warning);
  }
}, 10000); // every 10 seconds

// Delay middleware
app.addHook('preHandler', async (request, reply) => {
  // skip delay for health
  if (request.url === '/health') return;
  const delay = Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN + 1)) + DELAY_MIN;
  await new Promise(resolve => setTimeout(resolve, delay));
});

// Auth middleware
app.addHook('preHandler', async (request, reply) => {
  if (request.url === '/health') return;

  const key = request.headers['x-bmkg-key'] as string | undefined;
  const authHeader = request.headers['authorization'] as string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    // Looks like PVMBG token
    const err: ErrorEnvelope = { error: { code: 'FORBIDDEN', message: 'Cross-domain credential rejected' } };
    return reply.code(403).send(err);
  }

  if (!key || key !== API_KEY) {
    const err: ErrorEnvelope = { error: { code: 'UNAUTHORIZED', message: 'Invalid or missing X-BMKG-Key' } };
    return reply.code(401).send(err);
  }
});

app.get('/health', async (request, reply) => {
  const res: HealthResponse = {
    status: 'ok',
    service: 'bmkg-mock',
    timestamp: new Date().toISOString()
  };
  return reply.send(res);
});

app.get('/seismic-events', async (request, reply) => {
  const { since } = request.query as { since?: string };
  let data = seismicEvents;
  if (since) {
    const sinceDate = new Date(since).getTime();
    data = data.filter(e => new Date(e.occurred_at).getTime() >= sinceDate);
  }
  return { data };
});

app.get('/tsunami-warnings', async (request, reply) => {
  const { since } = request.query as { since?: string };
  let data = tsunamiWarnings;
  // Technically tsunami warnings might have generation time, but we'll use estimated_arrival or just the related event's occurred_at? 
  // Let's just use the estimated_arrival as they are created with the event. Wait, the spec says "filtering by occurred_at/generation time >= since".
  // Let's add a generated_at internally or just check estimated_arrival - 2h
  if (since) {
    const sinceDate = new Date(since).getTime();
    data = data.filter(w => new Date(w.estimated_arrival).getTime() - 7200000 >= sinceDate);
  }
  return { data };
});

app.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`bmkg-mock listening on ${address}`);
});
