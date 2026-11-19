// P2 demo on real processes: two satellite-processors share one Lease; the leader is killed mid-stream; the result must equal an undisturbed run.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';

const ROOT = join(__dirname, '../..');
const procs = new Set<ChildProcess>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const killGroup = (p: ChildProcess) => { try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ } };

function run(cmd: string, args: string[], cwd: string, env: Record<string, string>): ChildProcess {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: process.env.DEMO_LOGS ? 'inherit' : 'ignore', detached: true });
  procs.add(p);
  return p;
}
async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
}
const j = (url: string) => fetch(url).then((r) => r.json() as Promise<any>);

interface Run { checksum: string; count: number; takeoverMs: number | null; upstreamConnections: number; leaders: string[] }

async function scenario(label: string, base: number, killLeader: boolean): Promise<Run> {
  const tmp = mkdtempSync(join(tmpdir(), 'p2-'));
  const ports = [base, base + 1, base + 2];
  const STORAGE_UNITS = ports.map((p) => `http://127.0.0.1:${p}`).join(',');
  const own: ChildProcess[] = [];
  const spawnOwn = (...a: Parameters<typeof run>) => { const p = run(...a); own.push(p); return p; };
  ports.forEach((p, i) => spawnOwn('node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), { STORAGE_UNIT_PORT: String(p), STORAGE_UNIT_ID: `unit-${i}`, NODE_NAME: `node-${i}`, STORAGE_DATA_DIR: join(tmp, `u${i}`) }));
  const ring = new HttpStorageClient({ units: await discoverUnits({ STORAGE_UNITS }, 20), stateTtlMs: 0 });
  await ring.repair();
  const kubePort = base + 10, hostPort = base + 11, feedPort = base + 12;
  spawnOwn('npx', ['tsx', 'scripts/fake-apiserver.ts'], join(ROOT, 'services/aggregator'), { KUBE_API_PORT: String(kubePort), LEASE_NAMESPACE: 'bnpb' });
  spawnOwn('npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), { STORAGE_UNITS, AGGREGATOR_PORT: String(hostPort), INTERNAL_SERVICE_KEY: 'ik', STORAGE_STATE_TTL_MS: '200' });
  spawnOwn('node', ['tools/feed-fixture-server/server.mjs'], ROOT, { PORT: String(feedPort), FIXTURE_TOKEN: 'tok', FRAMES_PER_SECOND: killLeader ? '250' : '1500' });
  const kube = `http://127.0.0.1:${kubePort}`;
  const lease = () => j(`${kube}/apis/coordination.k8s.io/v1/namespaces/bnpb/leases/satellite`).catch(() => null);
  await until('host up', async () => (await fetch(`http://127.0.0.1:${hostPort}/internal/storage/ringStatus`, { method: 'POST', headers: { 'x-internal-key': 'ik', 'content-type': 'application/json' }, body: '{}' })).ok);

  const sat = (id: string, port: number) => spawnOwn('npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/satellite-processor'), {
    STORAGE_GATEWAY_URL: `http://127.0.0.1:${hostPort}`, INTERNAL_SERVICE_KEY: 'ik', KUBE_API_URL: kube, LEASE_NAMESPACE: 'bnpb', LEASE_DURATION_SECONDS: '4', LEASE_RENEW_INTERVAL_MS: '500',
    SAT_FEED_BASE_URL: `http://127.0.0.1:${feedPort}`, SAT_GROUP_TOKEN: 'tok', SATELLITE_PORT: String(port), POD_NAME: id, SAT_RECONNECT_MIN_MS: '200',
  });
  const procById = new Map<string, ChildProcess>([['sat-1', sat('sat-1', base + 21)], ['sat-2', sat('sat-2', base + 22)]]);

  const leaders: string[] = [];
  const first = await until('a leader', async () => (await lease())?.spec?.holderIdentity as string | undefined);
  leaders.push(first);
  let takeoverMs: number | null = null;
  if (killLeader) {
    await sleep(4000);
    const before = (await ring.checksum('SATELIT')).count;
    killGroup(procById.get(first)!);
    const t0 = Date.now();
    const second = await until('takeover', async () => { const h = (await lease())?.spec?.holderIdentity; return h && h !== first ? (h as string) : null; }, 30_000);
    takeoverMs = Date.now() - t0;
    leaders.push(second);
    line(`  [${label}] ${first} killed with ${before} events stored; ${second} took over after ${takeoverMs} ms (fence ${(await lease()).spec.leaseTransitions})`);
  }
  let last = -1, stable = 0;
  await until('feed drained', async () => {
    const c = (await ring.checksum('SATELIT')).count;
    stable = c === last ? stable + 1 : 0;
    last = c;
    return stable >= 40 && c > 0;
  }, 120_000);
  const cs = await ring.checksum('SATELIT');
  const stats = await j(`http://127.0.0.1:${feedPort}/admin/stats`);
  for (const p of own) killGroup(p);
  rmSync(tmp, { recursive: true, force: true });
  await sleep(500);
  return { checksum: cs.checksum, count: cs.count, takeoverMs, upstreamConnections: stats.connections ?? stats.connectionsTotal ?? -1, leaders };
}

async function main(): Promise<void> {
  const clean = await scenario('undisturbed', 18200, false);
  line(`undisturbed run: ${clean.count} satellite events, sha256=${clean.checksum.slice(0, 16)}…, leader=${clean.leaders[0]}`);
  const fail = await scenario('failover', 18300, true);
  line(`failover run: ${fail.count} satellite events, sha256=${fail.checksum.slice(0, 16)}…, leaders=${fail.leaders.join(' -> ')}`);
  const ok = clean.checksum === fail.checksum && clean.count === fail.count && fail.leaders.length === 2 && fail.takeoverMs !== null && fail.takeoverMs <= 60_000;
  line(`identical final result: ${clean.checksum === fail.checksum}; takeover within 60 s: ${fail.takeoverMs !== null && fail.takeoverMs <= 60_000}`);
  line(ok ? 'RESULT: PASS (leader killed, other instance took over, final result identical to the undisturbed run)' : 'RESULT: FAIL');
  process.exitCode = ok ? 0 : 1;
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs) killGroup(p); });
