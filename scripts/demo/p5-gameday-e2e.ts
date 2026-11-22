// P5-K6 / P5-K3 / P5-K8 on real processes: a combined, unannounced failure window against the REAL aggregator (2 instances), real RabbitMQ (docker), the REAL notifier,
// the ring and our sensor fixture. While Field-Team-style reads run continuously, four faults overlap: sensor outage, broker pause, kill of the aggregator holding the 'pantai' Lease,
// kill of a storage unit. Nobody intervenes (the faults end by themselves, like a broker coming back). Measures: reads of other sources (M1: BMKG-only p95 < 300 ms), alert delivery,
// duplicates, and the consumption of an error budget for the alert path SLO.
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
const stamp = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
const sig = (p: ChildProcess, s: NodeJS.Signals) => { try { process.kill(-p.pid!, s); } catch { /* gone */ } };
const sh = (c: string) => execSync(c, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };
const j = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers }).then((r) => r.json() as Promise<any>);
const pct = (xs: number[], q: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * q) - 1)]; };
async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(200); }
}
const CRIT_ARGS = { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': 'dlx_hazard' };
const CONTAINER = 'bnpb-gameday-rabbit';
let T0 = Date.now();

async function main(): Promise<void> {
  const base = 20200;
  const tmp = mkdtempSync(join(tmpdir(), 'gameday-'));
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
  const events = new Map<string, number>(); let evDup = 0;
  await ch.consume(evQ.queue, (m) => { if (!m) return; const id = m.properties.messageId as string; if (events.has(id)) evDup++; else events.set(id, Date.now()); ch.ack(m); });

  const ports = [base, base + 1, base + 2];
  ports.forEach((p, i) => run(`unit-${i}`, 'node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), { STORAGE_UNIT_PORT: String(p), STORAGE_UNIT_ID: `unit-${i}`, NODE_NAME: `node-${i}`, STORAGE_DATA_DIR: join(tmp, `u${i}`) }));
  const STORAGE_UNITS = ports.map((p) => `http://127.0.0.1:${p}`).join(',');
  const ring = new HttpStorageClient({ units: await discoverUnits({ STORAGE_UNITS }, 20), stateTtlMs: 0 });
  await ring.repair();
  const KUBE = `http://127.0.0.1:${base + 10}`, SENSOR = `http://127.0.0.1:${base + 11}`, BM = `http://127.0.0.1:${base + 12}`, PV = `http://127.0.0.1:${base + 13}`, NOTI = `http://127.0.0.1:${base + 30}`;
  run('kube', 'npx', ['tsx', 'scripts/fake-apiserver.ts'], join(ROOT, 'services/aggregator'), { KUBE_API_PORT: String(base + 10), LEASE_NAMESPACE: 'bnpb' });
  // Small pages so the sensor stream (60 pages at 600 ms) is still running while the faults overlap.
  run('sensor', 'node', ['tools/sensor-fixture-server/server.mjs'], ROOT, { PORT: String(base + 11), SENSOR_TOKEN: 'st', TOTAL: '300', PAGE_SIZE: '5' });
  run('bmkg', 'node', ['dist/services/bmkg-mock/src/index.js'], join(ROOT, 'services/bmkg-mock'), { BMKG_PORT: String(base + 12), BMKG_API_KEY: 'bk', BMKG_DELAY_MIN_MS: '5', BMKG_DELAY_MAX_MS: '20' });
  run('pvmbg', 'node', ['dist/services/pvmbg-mock/src/index.js'], join(ROOT, 'services/pvmbg-mock'), { PVMBG_PORT: String(base + 13), PVMBG_JWT_SECRET: 'ps', PVMBG_DELAY_MIN_MS: '5', PVMBG_DELAY_MAX_MS: '20', PVMBG_LIVE_INTERVAL_MS: '2000' });
  await until('mocks up', async () => (await fetch(`${BM}/health`)).ok && (await fetch(`${PV}/health`)).ok && (await fetch(`${SENSOR}/healthz`)).ok);
  const expected = await j(`${SENSOR}/admin/expected`);
  const pvToken = jwt.sign({ sub: 'aggregator' }, 'ps', { audience: 'pvmbg', expiresIn: '2h' });
  const aggPort = (id: string) => (id === 'agg-1' ? base + 20 : base + 21);
  const agg = (id: string) => run(id, 'npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/aggregator'), {
    AGGREGATOR_PORT: String(aggPort(id)), STORAGE_UNITS, KUBE_API_URL: KUBE, LEASE_NAMESPACE: 'bnpb', LEASE_DURATION_SECONDS: '4', LEASE_RENEW_INTERVAL_MS: '500', POD_NAME: id, HOSTNAME: id,
    RABBITMQ_URL: RABBIT, INTERNAL_SERVICE_KEY: 'ik', AUDIT_TOKEN: 'audit-secret', BMKG_BASE_URL: BM, BMKG_API_KEY: 'bk', PVMBG_BASE_URL: PV, PVMBG_ACCESS_TOKEN: pvToken,
    NOTIFIER_BASE_URL: NOTI, POLL_INTERVAL_MS: '1000', POLL_LOOKBACK_MS: '0', PANTAI_BASE_URL: SENSOR, PANTAI_AUTH_TOKEN: 'st', PANTAI_POLL_INTERVAL_MS: '600', STORAGE_REPAIR_INTERVAL_MS: '1000',
  });
  run('notifier', 'npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/consumers/notifier'), { RABBITMQ_URL: RABBIT, NOTIFIER_CONSUMER_PORT: String(base + 30) });
  await until('notifier ready', async () => (await fetch(`${NOTI}/health`)).ok, 60_000);
  // Baseline stack comes up before the stream starts: hold the sensor back by not starting the aggregators until now.
  agg('agg-1'); agg('agg-2');
  await until('aggregators up', async () => (await fetch(`http://127.0.0.1:${base + 20}/health`)).ok && (await fetch(`http://127.0.0.1:${base + 21}/health`)).ok, 90_000);
  const holder = async () => (await j(`${KUBE}/apis/coordination.k8s.io/v1/namespaces/bnpb/leases/pantai`).catch(() => null))?.spec?.holderIdentity as string | undefined;
  await until('pantai leader', holder, 30_000);
  await until('some observations stored', async () => (await ring.listEvents({ source: 'SENSOR_PANTAI', limit: 1000 })).items.length >= 15, 60_000);

  // Continuous read load, started before the faults: per read, try one aggregator then the other (what a load balancer would do); a failure is both failing.
  T0 = Date.now();
  const reads: Array<{ t: number; ok: boolean; ms: number; type: string; stale: boolean }> = [];
  let stop = false;
  const readLoop = async (type: 'SEISMIC' | 'COASTAL') => {
    let i = 0;
    while (!stop) {
      const t = Date.now(); let ok = false, stale = false;
      for (const k of [0, 1]) {
        const port = base + 20 + ((i + k) % 2);
        try {
          const r = await fetch(`http://127.0.0.1:${port}/internal/hazard-events?hazard_type=${type}&limit=50`, { headers: { 'x-internal-key': 'ik' }, signal: AbortSignal.timeout(2000) });
          if (r.ok) { const b = await r.json() as any; ok = true; stale = !!b.meta?.stale_since; break; }
        } catch { /* try the other instance */ }
      }
      reads.push({ t: t - T0, ok, ms: Date.now() - t, type, stale }); i++;
      await sleep(50);
    }
  };
  const loops = [readLoop('SEISMIC'), readLoop('SEISMIC'), readLoop('COASTAL')];
  line(`game day starts ${stamp()}; sensor stream is running`);

  // Fault schedule: overlapping and not announced to the system.
  // The broker goes first and the stream keeps running, so critical alerts are produced while it is paused (they must wait in the outbox).
  await sleep(1500);
  sh(`docker pause ${CONTAINER}`); line(`${stamp()} FAULT broker paused for 14 s (sensor stream keeps producing critical observations)`);
  await sleep(1000);
  await fetch(`${SENSOR}/admin/outage?ms=4000`, { method: 'POST' }); line(`${stamp()} FAULT sensor outage for 4 s`);
  await sleep(1500);
  const leader = (await holder())!; sig(procs.get(leader)!, 'SIGKILL'); line(`${stamp()} FAULT aggregator ${leader} (pantai leader) killed`);
  await sleep(1500);
  sig(procs.get('unit-1')!, 'SIGKILL'); line(`${stamp()} FAULT storage unit-1 killed`);
  await sleep(10000);
  sh(`docker unpause ${CONTAINER}`); line(`${stamp()} broker back`);
  const survivor = leader === 'agg-1' ? 'agg-2' : 'agg-1';
  const next = await until('pantai takeover', async () => { const h = await holder(); return h && h !== leader ? h : null; }, 30_000);
  line(`${stamp()} Lease taken over by ${next} (no operator action)`);

  // Critical consumer is the real notifier: wait until every expected critical alert has been delivered, then read the Audit report.
  const AUD = `http://127.0.0.1:${aggPort(survivor)}/internal/audit/critical-deliveries?limit=200`;
  await until('stream stored', async () => (await ring.listEvents({ source: 'SENSOR_PANTAI', limit: 1000 })).items.length >= expected.valid.length, 150_000);
  const rep = await until('notifier deliveries', async () => { const r = await j(AUD, { authorization: 'Bearer audit-secret' }); return r.total >= expected.critical.length ? r : null; }, 60_000).catch(async () => j(AUD, { authorization: 'Bearer audit-secret' }));
  await sleep(1500);
  stop = true; await Promise.all(loops);
  line(`game day over ${stamp()}`);

  const coastal = (await ring.listEvents({ source: 'SENSOR_PANTAI', limit: 1000 })).items;
  const ids = coastal.map((e) => e.source_ref_id);
  const wantCrit = new Set<string>(coastal.filter((e) => (e.attributes as any)?.critical === true).map((e) => outboxMessageId(e.hazard_id, 1)));
  const got = new Set<string>((rep.items as any[]).map((i) => i.message_id));
  const delays = (rep.items as any[]).map((i) => Number(i.e2e_seconds ?? NaN)).filter((x) => !Number.isNaN(x));
  const within = (rep.items as any[]).filter((i) => Number(i.e2e_seconds ?? 1e9) <= 5).length;
  line(`critical alerts: ${rep.total} delivered of ${expected.critical.length} expected; notifier p95 ${rep.p95_seconds} s; ${delays.length ? `max ${Math.max(...delays).toFixed(1)} s; ` : ''}${within} within 5 s`);
  const seis = reads.filter((r) => r.type === 'SEISMIC'), coast = reads.filter((r) => r.type === 'COASTAL');
  const okRatio = (xs: typeof reads) => xs.filter((r) => r.ok).length / Math.max(1, xs.length);
  const seisP95 = pct(seis.filter((r) => r.ok).map((r) => r.ms), 0.95);
  line(`reads: SEISMIC ${seis.length} (ok ${(okRatio(seis) * 100).toFixed(2)} %, p95 ${seisP95} ms, max ${Math.max(...seis.map((r) => r.ms))} ms); COASTAL ${coast.length} (ok ${(okRatio(coast) * 100).toFixed(2)} %, stale-marked ${coast.filter((r) => r.stale).length}, p95 ${pct(coast.filter((r) => r.ok).map((r) => r.ms), 0.95)} ms)`);
  const failed = reads.filter((r) => !r.ok);
  line(`failed reads: ${failed.length}${failed.length ? ` between ${(failed[0].t / 1000).toFixed(1)} s and ${(failed[failed.length - 1].t / 1000).toFixed(1)} s` : ''}`);
  // The mocks keep producing, so wait for the dispatcher to drain what was written before the end of the window.
  let outbox = await ring.outboxPending();
  for (let k = 0; k < 30 && outbox > 0; k++) { await sleep(500); outbox = await ring.outboxPending(); }
  const missingEv = [...(await ring.listEvents({ source: 'SENSOR_PANTAI', limit: 1000 })).items].map((e) => outboxMessageId(e.hazard_id, 1)).filter((id) => !events.has(id));

  // Error budget for SLO "99 % of seismic reads succeed under 300 ms" over the game day window.
  const slow = seis.filter((r) => !r.ok || r.ms >= 300).length;
  const budget = 0.01 * seis.length;
  line(`error budget (SLO: 99 % of SEISMIC reads ok and < 300 ms): ${slow} bad of ${seis.length}; budget ${budget.toFixed(1)} bad allowed; consumed ${(slow / budget * 100).toFixed(0)} %`);
  const budgetAlert = (rep.total - within) / Math.max(1, rep.total);
  line(`error budget (SLO: 95 % of critical alerts delivered within 5 s): ${rep.total - within} late of ${rep.total} = ${(budgetAlert * 100).toFixed(0)} % late; allowed 5 %; consumed ${(budgetAlert / 0.05 * 100).toFixed(0)} %`);

  check(`P5-K6: every valid observation stored exactly once despite four overlapping faults (${coastal.length} of ${expected.valid.length}, ${new Set(ids).size} distinct)`, coastal.length === expected.valid.length && new Set(ids).size === ids.length);
  check(`P5-K6: no critical alert lost (${rep.total} delivered of ${wantCrit.size}), ids match`, rep.total === wantCrit.size && [...wantCrit].every((id) => got.has(id)));
  check(`P5-K6: no event lost on the exchange (0 missing), outbox drained (${outbox} pending), ${evDup} at-least-once re-deliveries on the exchange, deduplicated by message_id at consumers)`, missingEv.length === 0 && outbox === 0);
  check(`P5-K6: recovery without intervention (Lease taken over by ${next}; stream finished; sensor, broker back by themselves)`, next !== leader);
  check(`P5-K3: SEISMIC reads keep M1 latency during the sensor outage (p95 ${seisP95} ms < 300 ms)`, seisP95 < 300);
  check(`P5-K4: COASTAL reads stayed available (${(okRatio(coast) * 100).toFixed(1)} % ok)`, okRatio(coast) >= 0.95);

  await conn.close().catch(() => undefined);
  for (const p of procs.values()) sig(p, 'SIGKILL');
  try { sh(`docker rm -f ${CONTAINER}`); } catch { /* gone */ }
  rmSync(tmp, { recursive: true, force: true });
  line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
main().catch((e) => { process.stderr.write(`${e}\n`); try { sh(`docker rm -f ${CONTAINER}`); } catch { /* gone */ } process.exitCode = 1; });
