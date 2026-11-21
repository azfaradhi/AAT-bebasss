// INT-3.1 / P5-K1 / X-05: the REAL aggregator (services/aggregator/src/index.ts, two instances) with a real RabbitMQ (docker), the mocks, our sensor fixture and the ring.
// Phase A is clean (critical queue ready): p95 critical delivery. Phase B injects faults: the critical queue appears late, the broker is paused, a storage unit is killed;
// nothing may be lost. The consumer is ours (amqplib), not the notifier service.
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outboxMessageId } from '../../shared-types/src/m2/ids';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';

const ROOT = join(__dirname, '../..');
const req = createRequire(join(ROOT, 'services/aggregator/package.json'));
const amqp = req('amqplib') as typeof import('amqplib');
const jwt = createRequire(join(ROOT, 'services/client-api/package.json'))('jsonwebtoken') as { sign: (p: object, s: string, o: object) => string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const sig = (p: ChildProcess, s: NodeJS.Signals) => { try { process.kill(-p.pid!, s); } catch { /* gone */ } };
const sh = (c: string) => execSync(c, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };
const j = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers }).then((r) => r.json() as Promise<any>);
async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(200); }
}
const CRIT_ARGS = { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': 'dlx_hazard' };
const CONTAINER = 'bnpb-e2e-rabbit';

async function scenario(label: string, base: number, faults: boolean, realNotifier = false): Promise<void> {
  line(`--- ${label} ---`);
  const tmp = mkdtempSync(join(tmpdir(), 'full-'));
  const procs = new Map<string, ChildProcess>();
  const run = (name: string, cmd: string, args: string[], cwd: string, env: Record<string, string>) => procs.set(name, spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: process.env.DEMO_LOGS ? 'inherit' : 'ignore', detached: true }));
  try { sh(`docker rm -f ${CONTAINER}`); } catch { /* none */ }
  const amqpPort = base + 40;
  sh(`docker run -d --name ${CONTAINER} -p ${amqpPort}:5672 -e RABBITMQ_DEFAULT_USER=bnpb -e RABBITMQ_DEFAULT_PASS=pw rabbitmq:3.13-management-alpine`);
  const RABBIT = `amqp://bnpb:pw@127.0.0.1:${amqpPort}`;
  const conn = await until('rabbitmq up', async () => amqp.connect(RABBIT), 120_000);
  const ch = await conn.createChannel();
  await ch.assertExchange('hazard_events_exchange', 'fanout', { durable: true });
  const evQ = await ch.assertQueue('e2e_events', { durable: true });
  await ch.bindQueue(evQ.queue, 'hazard_events_exchange', '');
  const events = new Map<string, number>(); const criticals = new Map<string, { latencyMs: number; at: number }>(); let evDup = 0, critDup = 0;
  await ch.consume(evQ.queue, (m) => { if (!m) return; const id = m.properties.messageId as string; if (events.has(id)) evDup++; else events.set(id, Date.now()); ch.ack(m); });
  const startCriticalConsumer = async () => {
    await ch.assertExchange('dlx_hazard', 'fanout', { durable: true });
    await ch.assertQueue('critical_alerts_queue', { durable: true, arguments: CRIT_ARGS });
    await ch.consume('critical_alerts_queue', (m) => {
      if (!m) return; const a = JSON.parse(m.content.toString()); const id = a.message_id as string;
      if (criticals.has(id)) critDup++; else criticals.set(id, { latencyMs: Date.now() - Date.parse(a.detected_at), at: Date.now() });
      ch.ack(m);
    });
  };
  if (!faults && !realNotifier) await startCriticalConsumer();

  const ports = [base, base + 1, base + 2];
  ports.forEach((p, i) => run(`unit-${i}`, 'node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), { STORAGE_UNIT_PORT: String(p), STORAGE_UNIT_ID: `unit-${i}`, NODE_NAME: `node-${i}`, STORAGE_DATA_DIR: join(tmp, `u${i}`) }));
  const STORAGE_UNITS = ports.map((p) => `http://127.0.0.1:${p}`).join(',');
  const ring = new HttpStorageClient({ units: await discoverUnits({ STORAGE_UNITS }, 20), stateTtlMs: 0 });
  await ring.repair();
  const KUBE = `http://127.0.0.1:${base + 10}`, SENSOR = `http://127.0.0.1:${base + 11}`, BM = `http://127.0.0.1:${base + 12}`, PV = `http://127.0.0.1:${base + 13}`;
  run('kube', 'npx', ['tsx', 'scripts/fake-apiserver.ts'], join(ROOT, 'services/aggregator'), { KUBE_API_PORT: String(base + 10), LEASE_NAMESPACE: 'bnpb' });
  run('sensor', 'node', ['tools/sensor-fixture-server/server.mjs'], ROOT, { PORT: String(base + 11), SENSOR_TOKEN: 'st', TOTAL: '300', PAGE_SIZE: '20' });
  run('bmkg', 'node', ['dist/services/bmkg-mock/src/index.js'], join(ROOT, 'services/bmkg-mock'), { BMKG_PORT: String(base + 12), BMKG_API_KEY: 'bk', BMKG_DELAY_MIN_MS: '5', BMKG_DELAY_MAX_MS: '20' });
  run('pvmbg', 'node', ['dist/services/pvmbg-mock/src/index.js'], join(ROOT, 'services/pvmbg-mock'), { PVMBG_PORT: String(base + 13), PVMBG_JWT_SECRET: 'ps', PVMBG_DELAY_MIN_MS: '5', PVMBG_DELAY_MAX_MS: '20', PVMBG_LIVE_INTERVAL_MS: '2000' });
  await until('mocks up', async () => (await fetch(`${BM}/health`)).ok && (await fetch(`${PV}/health`)).ok && (await fetch(`${SENSOR}/healthz`)).ok);
  const expected = await j(`${SENSOR}/admin/expected`);
  const pvToken = jwt.sign({ sub: 'aggregator' }, 'ps', { audience: 'pvmbg', expiresIn: '2h' });
  const agg = (id: string, port: number) => run(id, 'npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/aggregator'), {
    AGGREGATOR_PORT: String(port), STORAGE_UNITS, KUBE_API_URL: KUBE, LEASE_NAMESPACE: 'bnpb', LEASE_DURATION_SECONDS: '4', LEASE_RENEW_INTERVAL_MS: '500', POD_NAME: id, HOSTNAME: id,
    RABBITMQ_URL: RABBIT, INTERNAL_SERVICE_KEY: 'ik', AUDIT_TOKEN: 'audit-secret', BMKG_BASE_URL: BM, BMKG_API_KEY: 'bk', PVMBG_BASE_URL: PV, PVMBG_ACCESS_TOKEN: pvToken,
    ...(realNotifier ? { NOTIFIER_BASE_URL: `http://127.0.0.1:${base + 30}` } : {}), POLL_INTERVAL_MS: '1000', POLL_LOOKBACK_MS: '0', PANTAI_BASE_URL: SENSOR, PANTAI_AUTH_TOKEN: 'st', PANTAI_POLL_INTERVAL_MS: '600', STORAGE_REPAIR_INTERVAL_MS: '1000',
  });
  if (realNotifier) run('notifier', 'npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/consumers/notifier'), { RABBITMQ_URL: RABBIT, NOTIFIER_CONSUMER_PORT: String(base + 30) });
  // The notifier is up (queues declared, consuming) before any alert is produced, so the p95 measures delivery, not notifier start-up time.
  if (realNotifier) await until('notifier ready', async () => (await fetch(`http://127.0.0.1:${base + 30}/health`)).ok, 60_000);
  const t0 = Date.now();
  agg('agg-1', base + 20); agg('agg-2', base + 21);
  await until('aggregators up', async () => (await fetch(`http://127.0.0.1:${base + 20}/health`)).ok && (await fetch(`http://127.0.0.1:${base + 21}/health`)).ok, 90_000);

  if (faults) {
    await sleep(4000);
    sh(`docker pause ${CONTAINER}`); line('  broker paused for 8 s; critical queue does not exist yet');
    await sleep(8000);
    sh(`docker unpause ${CONTAINER}`);
    const k = procs.get('unit-1')!; sig(k, 'SIGKILL'); line('  storage unit-1 killed');
    await sleep(4000);
    await startCriticalConsumer(); line('  critical queue created and consumed (late)');
  }

  const coastal = async () => (await ring.listEvents({ source: 'SENSOR_PANTAI', limit: 1000 })).items;
  await until('sensor stream stored', async () => (await coastal()).length >= expected.valid.length, 150_000);
  const allEvents = async () => { const out: any[] = []; for (const s of ['BMKG', 'PVMBG', 'SATELIT', 'SENSOR_PANTAI'] as const) { let cursor: string | undefined; do { const pg = await ring.listEvents({ source: s, limit: 1000, cursor }); out.push(...pg.items); cursor = pg.next_cursor ?? undefined; } while (cursor); } return out; };
  await sleep(1000);
  // Snapshot what is stored now (the mocks keep producing), then everything in it must be delivered.
  const stored = await allEvents();
  const wantEv = stored.map((e) => outboxMessageId(e.hazard_id, 1));
  const wantCrit = new Set<string>((await coastal()).filter((e) => (e.attributes as any)?.critical === true).map((e) => outboxMessageId(e.hazard_id, 1)));
  await until('all events and critical alerts delivered', async () => (wantEv.every((id) => events.has(id)) && [...wantCrit].every((id) => criticals.has(id)) ? true : null), 120_000).catch(() => null);
  const missingEv = wantEv.filter((id) => !events.has(id));
  const missingCrit = [...wantCrit].filter((id) => !criticals.has(id));
  if (realNotifier) {
    // The real notifier consumed the critical queue; the Audit API (aggregator -> notifier) reports what it delivered.
    const AUD = `http://127.0.0.1:${base + 20}/internal/audit/critical-deliveries?limit=200`;
    const rep = await until('notifier deliveries', async () => { const r = await j(AUD, { authorization: 'Bearer audit-secret' }); return r.total >= expected.critical.length ? r : null; }, 60_000).catch(async () => j(AUD, { authorization: 'Bearer audit-secret' }));
    const got = new Set<string>((rep.items as any[]).map((i) => i.message_id));
    line(`  real notifier via Audit /internal/audit/critical-deliveries: total ${rep.total}, p95 ${rep.p95_seconds} s`);
    check(`${label}: the Audit API lists every critical alert the notifier delivered (${rep.total} of ${wantCrit.size}), ids match`, rep.total === wantCrit.size && [...wantCrit].every((id) => got.has(id)));
    check(`${label}: notifier-reported end-to-end p95 ${rep.p95_seconds} s <= 5 s (P5-K1 target)`, typeof rep.p95_seconds === 'number' && rep.p95_seconds <= 5);
  }
  const lat = [...criticals.values()].map((c) => c.latencyMs).sort((a, b) => a - b);
  const p95 = lat.length ? lat[Math.max(0, Math.ceil(lat.length * 0.95) - 1)] : NaN;
  line(`  ${stored.length} events stored, ${wantEv.length - missingEv.length} delivered to the exchange queue (${evDup} duplicate deliveries); ${expected.critical.length} critical observations, ${criticals.size} critical alerts delivered (${critDup} duplicates), detected->received p50 ${lat[Math.floor(lat.length / 2)]} ms, p95 ${p95} ms, max ${lat[lat.length - 1]} ms; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  check(`${label}: every stored event reached a consumer of the fanout exchange (0 missing of ${stored.length})`, missingEv.length === 0);
  check(`${label}: every critical observation produced a critical alert on critical_alerts_queue (0 missing of ${wantCrit.size})`, wantCrit.size === expected.critical.length && (realNotifier || missingCrit.length === 0));
  if (!faults && !realNotifier) check(`${label}: critical delivery p95 ${p95} ms <= 5000 ms (P5-K1 target)`, p95 <= 5000);
  const outbox = await ring.outboxPending();
  check(`${label}: outbox drained (${outbox} pending)`, outbox === 0);

  await conn.close().catch(() => undefined);
  for (const p of procs.values()) sig(p, 'SIGKILL');
  try { sh(`docker rm -f ${CONTAINER}`); } catch { /* gone */ }
  rmSync(tmp, { recursive: true, force: true });
  await sleep(1500);
}

async function main(): Promise<void> {
  if (process.env.ONLY !== 'B' && process.env.ONLY !== 'C') await scenario('A clean', 19900, false);
  if (process.env.ONLY === 'C') await scenario('C clean with the real notifier service', 20100, false, true);
  if (process.env.ONLY !== 'A' && process.env.ONLY !== 'C') await scenario('B faults (late critical queue, broker paused 8 s, storage unit killed)', 20000, true);
  line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
main().catch((e) => { process.stderr.write(`${e}\n`); try { sh(`docker rm -f ${CONTAINER}`); } catch { /* gone */ } process.exitCode = 1; });
