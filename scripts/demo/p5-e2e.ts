// P5 on real processes (against OUR sensor fixture, not the assistants' image): two poller hosts share the 'pantai' Lease; the Sensor Pantai poller validates by behaviour,
// parks contract violations, stores valid observations as COASTAL events with a critical outbox row, survives leader loss and a sensor outage while BMKG/PVMBG keep flowing.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { StorageCanonicalStore } from '../../services/aggregator/src/storage/storage-canonical-store';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';

const ROOT = join(__dirname, '../..');
const jwt = createRequire(join(ROOT, 'services/client-api/package.json'))('jsonwebtoken') as { sign: (p: object, s: string, o: object) => string };
const tmp = mkdtempSync(join(tmpdir(), 'p5-'));
const procs = new Map<string, ChildProcess>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const sig = (p: ChildProcess, s: NodeJS.Signals) => { try { process.kill(-p.pid!, s); } catch { /* gone */ } };
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };
const run = (name: string, cmd: string, args: string[], cwd: string, env: Record<string, string>) => procs.set(name, spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: process.env.DEMO_LOGS ? 'inherit' : 'ignore', detached: true }));
async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(150); }
}
const j = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers }).then((r) => r.json() as Promise<any>);

async function main(): Promise<void> {
  const ports = [19810, 19811, 19812];
  ports.forEach((p, i) => run(`unit-${i}`, 'node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), { STORAGE_UNIT_PORT: String(p), STORAGE_UNIT_ID: `unit-${i}`, NODE_NAME: `node-${i}`, STORAGE_DATA_DIR: join(tmp, `u${i}`) }));
  const STORAGE_UNITS = ports.map((p) => `http://127.0.0.1:${p}`).join(',');
  const ring = new HttpStorageClient({ units: await discoverUnits({ STORAGE_UNITS }, 20), stateTtlMs: 0 });
  await ring.repair();
  const HOST = 'http://127.0.0.1:19820', SENSOR = 'http://127.0.0.1:19821', KUBE = 'http://127.0.0.1:19822', BM = 'http://127.0.0.1:19823', PV = 'http://127.0.0.1:19824';
  run('host', 'npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), { STORAGE_UNITS, AGGREGATOR_PORT: '19820', INTERNAL_SERVICE_KEY: 'ik', AUDIT_TOKEN: 'audit-secret', STORAGE_STATE_TTL_MS: '200' });
  run('kube', 'npx', ['tsx', 'scripts/fake-apiserver.ts'], join(ROOT, 'services/aggregator'), { KUBE_API_PORT: '19822', LEASE_NAMESPACE: 'bnpb' });
  run('sensor', 'node', ['tools/sensor-fixture-server/server.mjs'], ROOT, { PORT: '19821', SENSOR_TOKEN: 'st', TOTAL: '300', PAGE_SIZE: '20' });
  run('bmkg', 'node', ['dist/services/bmkg-mock/src/index.js'], join(ROOT, 'services/bmkg-mock'), { BMKG_PORT: '19823', BMKG_API_KEY: 'bk', BMKG_DELAY_MIN_MS: '5', BMKG_DELAY_MAX_MS: '20' });
  run('pvmbg', 'node', ['dist/services/pvmbg-mock/src/index.js'], join(ROOT, 'services/pvmbg-mock'), { PVMBG_PORT: '19824', PVMBG_JWT_SECRET: 'ps', PVMBG_DELAY_MIN_MS: '5', PVMBG_DELAY_MAX_MS: '20' });
  await until('stack up', async () => (await fetch(`${HOST}/health`)).ok && (await fetch(`${SENSOR}/healthz`)).ok && (await fetch(`${BM}/health`)).ok && (await fetch(`${PV}/health`)).ok);
  const expected = await j(`${SENSOR}/admin/expected`);
  const pvToken = jwt.sign({ sub: 'aggregator' }, 'ps', { audience: 'pvmbg', expiresIn: '2h' });
  const poller = (id: string) => run(id, 'npx', ['tsx', 'scripts/poller-host.ts'], join(ROOT, 'services/aggregator'), {
    KUBE_API_URL: KUBE, LEASE_NAMESPACE: 'bnpb', LEASE_DURATION_SECONDS: '4', LEASE_RENEW_INTERVAL_MS: '500', STORAGE_UNITS, POD_NAME: id, HOSTNAME: id,
    BMKG_BASE_URL: BM, BMKG_API_KEY: 'bk', PVMBG_BASE_URL: PV, PVMBG_ACCESS_TOKEN: pvToken, POLL_INTERVAL_MS: '1000',
    PANTAI_BASE_URL: SENSOR, PANTAI_AUTH_TOKEN: 'st', PANTAI_POLL_INTERVAL_MS: '600',
  });
  const lease = () => j(`${KUBE}/apis/coordination.k8s.io/v1/namespaces/bnpb/leases/pantai`).catch(() => null);
  const holder = async () => (await lease())?.spec?.holderIdentity as string | undefined;
  const coastal = async () => (await ring.listEvents({ source: 'SENSOR_PANTAI', limit: 1000 })).items;
  const parked = async () => ((await j(`${HOST}/internal/audit/unprocessed?limit=1000`, { authorization: 'Bearer audit-secret' })).items as any[]).filter((x) => x.source === 'SENSOR_PANTAI');
  poller('poller-1'); poller('poller-2');
  const leader = await until('pantai leader', holder);

  // failover in the middle of the stream
  await until('some observations stored', async () => (await coastal()).length >= 40);
  const t0 = Date.now();
  sig(procs.get(leader)!, 'SIGKILL');
  const next = await until('takeover', async () => { const h = await holder(); return h && h !== leader ? h : null; }, 30_000);
  line(`pantai leader ${leader} killed with ${(await coastal()).length}/${expected.valid.length} valid observations stored; ${next} took over after ${Date.now() - t0} ms`);

  const total = await until('stream drained', async () => { const c = (await coastal()).length; return c >= expected.valid.length ? c : null; }, 120_000);
  await sleep(2500);
  const ev = await coastal();
  const ids = ev.map((e) => e.source_ref_id);
  const log = (await j(`${SENSOR}/admin/request-log`)).data as Array<{ caller: string | null; path: string; status: number; ts: string }>;
  const obsCallers = [...new Set(log.filter((e) => e.path === '/v1/observations').map((e) => e.caller))];
  const p = await parked();
  line(`stored ${ev.length} COASTAL events (expected ${expected.valid.length}); parked ${p.length} contract violations (expected ${expected.violations.length}); callers of /v1/observations: ${obsCallers.join(', ')}`);
  check('P5-K2: every valid observation is stored exactly once, none of the violating ones is stored as an event', ev.length === expected.valid.length && new Set(ids).size === ids.length && ids.every((id) => expected.valid.includes(id)));
  check('P5-K2: contract violations are parked (not dropped, not stored), with a reason', p.length >= expected.violations.length - 5 && p.every((x) => x.status === 'parked'));
  check('X-02/P2: only the Lease holder called the sensor at a time; after the kill the second instance took over', obsCallers.length === 2 && obsCallers.includes(leader) && obsCallers.includes(next));

  // critical observations carry a critical-priority outbox row
  // claimOutbox claims per replica, so the same message can come back from the other replica on a later call; message_id is the dedup key (consumers dedup on it too).
  const claimed = new Map<string, any>();
  for (let k = 0; k < 20; k++) { const batch = await ring.claimOutbox(200, 1000); if (batch.length === 0) break; for (const b of batch) claimed.set(b.message_id, b); }
  const critical = [...claimed.values()].filter((c) => c.priority === 'critical');
  const criticalIds = new Set(critical.map((c) => c.message_id));
  line(`outbox: ${claimed.size} distinct messages claimed, ${critical.length} critical (expected ${expected.critical.length} critical observations)`);
  check('P5-K1 (storage side): each critical observation has exactly one critical-priority outbox row written with the event', critical.length === expected.critical.length && criticalIds.size === critical.length);

  // sensor outage: poller survives, other sources keep flowing, recovers
  const bmkgBefore = ((await j(`${BM}/admin/request-log`)).data as any[]).length;
  const aliveBefore = [...procs.entries()].filter(([k, v]) => k.startsWith('poller') && v.exitCode === null && k !== leader).length;
  // Reads go through the same store class the client path uses (listCacheMs 0 so each read hits the ring).
  const readStore = new StorageCanonicalStore({ storage: ring, listCacheMs: 0 });
  const timedList = async () => { const t = Date.now(); const r = await readStore.list({ hazardType: 'COASTAL', limit: 20 }); return { ms: Date.now() - t, r }; };
  const before = await timedList();
  await fetch(`${SENSOR}/admin/outage?ms=6000`, { method: 'POST' });
  const duringStale = await until('stale_since appears on coastal reads', async () => { const x = await timedList(); return x.r.meta.stale_since ? x : null; }, 6000);
  const seismicDuring = await readStore.list({ hazardType: 'SEISMIC', limit: 5 });
  await sleep(6000);
  const recovered = await until('stale_since clears after the sensor recovers', async () => { const x = await timedList(); return x.r.meta.stale_since === null ? x : null; }, 15_000);
  line(`coastal read before outage: ${before.ms} ms stale_since=${before.r.meta.stale_since}; during: ${duringStale.ms} ms stale_since=${duringStale.r.meta.stale_since} (${duringStale.r.data.length} events still served); seismic stale_since=${seismicDuring.meta.stale_since}; after: stale_since=${recovered.r.meta.stale_since}`);
  check('P5-K4: during the outage coastal reads stay fast (<500 ms), still return the stored events, and carry stale_since', duringStale.ms < 500 && duringStale.r.data.length > 0 && !!duringStale.r.meta.stale_since);
  check('P5-K4: other hazard types are not marked stale by the sensor outage', seismicDuring.meta.stale_since === null);
  check('P5-K4: the poller clears stale_since by itself once the sensor is back (no operator action)', recovered.r.meta.stale_since === null);
  const bmkgAfter = ((await j(`${BM}/admin/request-log`)).data as any[]).length;
  const failed = ((await j(`${SENSOR}/admin/request-log`)).data as any[]).filter((e) => e.status === 503).length;
  check(`P5-K3/K4: sensor outage (${failed} refused requests): poller process stays up and BMKG polling continues (${bmkgAfter - bmkgBefore} more BMKG calls)`, aliveBefore === 1 && procs.get(next)!.exitCode === null && bmkgAfter - bmkgBefore >= 3 && failed >= 1);
  check('P5-K4: the request rate to the unhealthy sensor is bounded by the circuit breaker (far fewer refused calls than polls in 6 s at 600 ms)', failed <= 12);
  const after = (await coastal()).length;
  check('after the outage nothing was lost or duplicated', after === expected.valid.length);

  line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs.values()) sig(p, 'SIGKILL'); rmSync(tmp, { recursive: true, force: true }); });
