// P2-K4/K5 drills on real processes: wall-clock shifts (+45 s then -30 s) and a frozen leader (SIGSTOP/SIGCONT); the result must equal an undisturbed run.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';

const ROOT = join(__dirname, '../..');
const procs = new Set<ChildProcess>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const sig = (p: ChildProcess, s: NodeJS.Signals) => { try { process.kill(-p.pid!, s); } catch { /* gone */ } };
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };

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

interface Env { ring: HttpStorageClient; lease: () => Promise<any>; sat: (id: string, skewFile?: string) => ChildProcess; feedStats: () => Promise<any>; stop: () => void; tmp: string }

async function stack(base: number, fps: number): Promise<Env> {
  const tmp = mkdtempSync(join(tmpdir(), 'p2cf-'));
  const own: ChildProcess[] = [];
  const spawnOwn = (...a: Parameters<typeof run>) => { const p = run(...a); own.push(p); return p; };
  const ports = [base, base + 1, base + 2];
  const STORAGE_UNITS = ports.map((p) => `http://127.0.0.1:${p}`).join(',');
  ports.forEach((p, i) => spawnOwn('node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), { STORAGE_UNIT_PORT: String(p), STORAGE_UNIT_ID: `unit-${i}`, NODE_NAME: `node-${i}`, STORAGE_DATA_DIR: join(tmp, `u${i}`) }));
  const ring = new HttpStorageClient({ units: await discoverUnits({ STORAGE_UNITS }, 20), stateTtlMs: 0 });
  await ring.repair();
  const kubePort = base + 10, hostPort = base + 11, feedPort = base + 12;
  spawnOwn('npx', ['tsx', 'scripts/fake-apiserver.ts'], join(ROOT, 'services/aggregator'), { KUBE_API_PORT: String(kubePort), LEASE_NAMESPACE: 'bnpb' });
  spawnOwn('npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), { STORAGE_UNITS, AGGREGATOR_PORT: String(hostPort), INTERNAL_SERVICE_KEY: 'ik', STORAGE_STATE_TTL_MS: '200' });
  spawnOwn('node', ['tools/feed-fixture-server/server.mjs'], ROOT, { PORT: String(feedPort), FIXTURE_TOKEN: 'tok', FRAMES_PER_SECOND: String(fps) });
  const kube = `http://127.0.0.1:${kubePort}`;
  await until('host up', async () => (await fetch(`http://127.0.0.1:${hostPort}/internal/storage/ringStatus`, { method: 'POST', headers: { 'x-internal-key': 'ik', 'content-type': 'application/json' }, body: '{}' })).ok);
  let n = 0;
  const sat = (id: string, skewFile?: string) => spawnOwn('npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/satellite-processor'), {
    STORAGE_GATEWAY_URL: `http://127.0.0.1:${hostPort}`, INTERNAL_SERVICE_KEY: 'ik', KUBE_API_URL: kube, LEASE_NAMESPACE: 'bnpb', LEASE_DURATION_SECONDS: '4', LEASE_RENEW_INTERVAL_MS: '500',
    SAT_FEED_BASE_URL: `http://127.0.0.1:${feedPort}`, SAT_GROUP_TOKEN: 'tok', SATELLITE_PORT: String(base + 21 + n++), POD_NAME: id, SAT_RECONNECT_MIN_MS: '200',
    ...(skewFile ? { SKEW_FILE: skewFile, NODE_OPTIONS: `--require ${join(ROOT, 'scripts/demo/skew-preload.cjs')}` } : {}),
  });
  return {
    ring, tmp, sat,
    lease: () => j(`${kube}/apis/coordination.k8s.io/v1/namespaces/bnpb/leases/satellite`).catch(() => null),
    feedStats: () => j(`http://127.0.0.1:${feedPort}/admin/stats`),
    stop: () => { for (const p of own) sig(p, 'SIGKILL'); rmSync(tmp, { recursive: true, force: true }); },
  };
}

async function drain(env: Env): Promise<{ checksum: string; count: number }> {
  let last = -1, stable = 0;
  await until('feed drained', async () => { const c = (await env.ring.checksum('SATELIT')).count; stable = c === last ? stable + 1 : 0; last = c; return stable >= 40 && c > 0; }, 150_000);
  const cs = await env.ring.checksum('SATELIT');
  return { checksum: cs.checksum, count: cs.count };
}
const holder = async (env: Env) => (await env.lease())?.spec?.holderIdentity as string | undefined;
const transitions = async (env: Env) => Number((await env.lease())?.spec?.leaseTransitions ?? -1);

async function main(): Promise<void> {
  // 1. undisturbed reference
  const a = await stack(18400, 1500);
  a.sat('sat-1'); a.sat('sat-2');
  await until('leader', () => holder(a));
  const ref = await drain(a);
  line(`reference (undisturbed): ${ref.count} satellite events, sha256=${ref.checksum.slice(0, 16)}…`);
  a.stop(); await sleep(500);

  // 2. clock skew: sat-1 wall clock +45 s, sat-2 -30 s, then swapped mid-run; nobody is killed.
  const b = await stack(18500, 250);
  const f1 = join(b.tmp, 'skew1'), f2 = join(b.tmp, 'skew2');
  writeFileSync(f1, '45000'); writeFileSync(f2, '-30000');
  b.sat('sat-1', f1); b.sat('sat-2', f2);
  const lead = await until('leader', () => holder(b));
  const t0 = await transitions(b);
  const seen = new Set<string>([lead]);
  const poll = setInterval(() => void holder(b).then((h) => { if (h) seen.add(h); }), 100);
  await sleep(6000);
  writeFileSync(f1, '-30000'); writeFileSync(f2, '45000'); // swap the shifts while running
  await sleep(6000);
  clearInterval(poll);
  check(`clock +45 s / -30 s then swapped: one holder for the whole run (${[...seen].join(',')})`, seen.size === 1);
  check(`no spurious takeover from clock shift (leaseTransitions ${t0} -> ${await transitions(b)})`, (await transitions(b)) === t0);
  const skewed = await drain(b);
  check('clock-shift run: final events and sha256 identical to the undisturbed reference', skewed.checksum === ref.checksum && skewed.count === ref.count);
  b.stop(); await sleep(500);

  // 3. frozen leader: SIGSTOP longer than the lease, takeover, SIGCONT.
  const c = await stack(18600, 250);
  const procs2 = new Map<string, ChildProcess>([['sat-1', c.sat('sat-1')], ['sat-2', c.sat('sat-2')]]);
  const first = await until('leader', () => holder(c));
  await sleep(3000);
  const before = (await c.ring.checksum('SATELIT')).count;
  sig(procs2.get(first)!, 'SIGSTOP');
  const tf = Date.now();
  const second = await until('takeover after freeze', async () => { const h = await holder(c); return h && h !== first ? h : null; }, 30_000);
  line(`  frozen ${first} (SIGSTOP) with ${before} events stored; ${second} took over after ${Date.now() - tf} ms`);
  await sleep(3000);
  const fenceAtThaw = await transitions(c);
  sig(procs2.get(first)!, 'SIGCONT');
  await sleep(8000);
  check(`thawed ex-leader did not take the lease back (holder ${await holder(c)}, leaseTransitions ${fenceAtThaw} -> ${await transitions(c)})`, (await holder(c)) === second && (await transitions(c)) === fenceAtThaw);
  const frozen = await drain(c);
  check('freeze run: final events and sha256 identical to the undisturbed reference (no loss, no duplicates)', frozen.checksum === ref.checksum && frozen.count === ref.count);
  c.stop();

  line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs) sig(p, 'SIGKILL'); });
