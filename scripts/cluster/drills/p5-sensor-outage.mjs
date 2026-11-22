// P5-K3 / K4 on the cluster: the Sensor Pantai goes away; other sources keep flowing, client reads stay fast, requests to the sensor do not surge, and the system recovers by itself.
//   usage: node scripts/cluster/drills/p5-sensor-outage.mjs      env: OUTAGE_S=90
import { Evidence, audit, clientToken, expose, kubectl, p95, scale, sleep, timed } from './lib.mjs';

const OUTAGE = Number(process.env.OUTAGE_S ?? 90);
const ev = new Evidence('P5/K4', 'cluster-p5-sensor-outage', `P5-K3/K4: sensor-pantai scaled to 0 for ${OUTAGE} s`);
const aggregator = expose('aggregator', 8090), client = expose('client-api', 8080), auth = expose('auth-service', 8091), mock = expose('bmkg-mock', 8081);
const A = audit(aggregator);
const tok = await clientToken(auth, 'internal');
const read = async () => timed(`${client}/api/v1/hazards?limit=50`, { headers: { authorization: `Bearer ${tok}` } }, 8000);
const measure = async (secs) => { const ms = [], bad = []; const end = Date.now() + secs * 1000; while (Date.now() < end) { const r = await read(); ms.push(r.ms); if (r.status !== 200) bad.push(r.status); await sleep(500); } return { ms, bad }; };
const mockCalls = async (sinceMs) => ((await timed(`${mock}/admin/request-log?since=${encodeURIComponent(new Date(sinceMs).toISOString())}`)).body?.data ?? []).filter((e) => e.caller_instance).length;
const breaker = async () => { const t = (await timed(`${aggregator}/metrics`)).text ?? ''; return t.split('\n').filter((l) => l.startsWith('bnpb_breaker_state') && l.includes('sensor')).join(' ') || 'n/a'; };

const base = await measure(20);
ev.log(`baseline client reads: p95 ${p95(base.ms).toFixed(0)} ms, non-200: ${base.bad.length}`);
const sensorBefore = (await A.checksum('SENSOR_PANTAI')).count;
scale('sensor-pantai', 0); const t0 = Date.now();
ev.log('sensor-pantai scaled to 0');
const during = await measure(OUTAGE);
const mc = await mockCalls(t0);
ev.log(`during the outage: client reads p95 ${p95(during.ms).toFixed(0)} ms, non-200 ${during.bad.length}; BMKG mock calls ${mc}; breaker: ${await breaker()}`);
ev.check('K4: client reads stay fast during the outage (p95 < 2000 ms, no timeout waiting for the sensor)', p95(during.ms) < 2000 && during.bad.length === 0);
ev.check('K3: the other sources keep being polled during the outage (BMKG mock still called)', mc > 3, `${mc} calls`);
ev.check('K4: the breaker for the sensor opened (request rate to the sensor is bounded)', /sensor/.test(await breaker()), await breaker());
scale('sensor-pantai', 1);
ev.log('sensor-pantai scaled back to 1; waiting for the aggregator to use it again without intervention');
await sleep(120_000);
const after = await measure(15);
const sensorAfter = (await A.checksum('SENSOR_PANTAI')).count;
ev.log(`after recovery: reads p95 ${p95(after.ms).toFixed(0)} ms; SENSOR_PANTAI events ${sensorBefore} -> ${sensorAfter}; breaker: ${await breaker()}`);
ev.check('K4: the system returned to normal on its own (reads fine, breaker not open)', p95(after.ms) < 2000 && after.bad.length === 0);
ev.done();
