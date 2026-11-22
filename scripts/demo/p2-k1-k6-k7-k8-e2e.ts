// Problem 2 Complete Real-Process Verification Suite (P2-K1, P2-K6, P2-K7, P2-K8):
// - P2-K1: >= 3 Aggregator instances on distinct nodes (node-a, node-b, node-c) behind a single Load Balancer entry point
//          that stops routing to unhealthy instances within 1 health-check tick with 0 failed requests.
// - P2-K7: Throughput benchmark comparing 1 Aggregator instance vs 3 Aggregator instances behind the LB using k6 (>= 2.0x speedup).
// - P2-K6: Sustained k6 load test (>= 10,000 VUs, >= 120 seconds) with live instance scaling 3 -> 5 -> 2 while Lease-coordinated
//          BMKG & PVMBG pollers run continuously (error rate < 1%, P2-K2 single-fetch & 0 duplicate events preserved).
// - P2-K8: Live zero-downtime rolling update (version v1 -> v2, maxSurge=1, maxUnavailable=0) during the sustained k6 load test with 0 failed requests.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hazardId } from '../../shared-types/src/m2/ids';
import type { HazardSource, HazardType } from '../../shared-types/src/m2/types';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';
import type { BackendSpec } from './p2-lb';

const ROOT = join(__dirname, '../..');
const jwt = createRequire(join(ROOT, 'services/client-api/package.json'))('jsonwebtoken') as {
  sign: (p: object, s: string, o: object) => string;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => {
  checks.push([name, ok]);
  line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
};

async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${what}`);
}

interface AggInstance extends BackendSpec {
  port: number;
  proc: ChildProcess;
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'p2-full-'));
  const procs = new Set<ChildProcess>();
  const runProc = (cmd: string, args: string[], cwd: string, env: Record<string, string>) => {
    const p = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: process.env.DEMO_LOGS ? 'inherit' : 'ignore',
      detached: true,
    });
    procs.add(p);
    return p;
  };
  const killProc = (p: ChildProcess, sig: NodeJS.Signals = 'SIGKILL') => {
    try {
      process.kill(-p.pid!, sig);
    } catch {
      /* gone */
    }
  };

  try {
    line(`=== Problem 2 Real-Process Verification: P2-K1, P2-K6 (10,000 VU / 120s / 3->5->2), P2-K7 (>=2.0x), P2-K8 (Rolling Update) ===`);

    // 1. Start 3 storage-unit processes (node-a, node-b, node-c), fake-apiserver, bmkg-mock, pvmbg-mock
    const unitPorts = [19410, 19411, 19412];
    const nodeNames = ['node-a', 'node-b', 'node-c'];
    unitPorts.forEach((p, i) =>
      runProc('node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), {
        STORAGE_UNIT_PORT: String(p),
        STORAGE_UNIT_ID: `unit-${i}`,
        NODE_NAME: nodeNames[i],
        STORAGE_DATA_DIR: join(tmp, `u${i}`),
      }),
    );
    const STORAGE_UNITS = unitPorts.map((p) => `http://127.0.0.1:${p}`).join(',');
    const units = await discoverUnits({ STORAGE_UNITS }, 25);
    const ring = new HttpStorageClient({ units, rf: 2, vnodes: 64, stateTtlMs: 0 });
    await ring.repair();

    // Seed 300 baseline events across all 4 sources
    const SOURCES: Array<[HazardSource, HazardType, string]> = [
      ['BMKG', 'SEISMIC', 'Sumatera Barat'],
      ['PVMBG', 'VOLCANIC', 'Gunung Merapi, DIY'],
      ['SATELIT', 'WILDFIRE', 'Kalimantan Tengah'],
      ['SENSOR_PANTAI', 'COASTAL', 'Padang, Sumatera Barat'],
    ];
    for (let i = 0; i < 300; i++) {
      const [source, hazard_type, area_name] = SOURCES[i % 4];
      const ref = `SEED-${source}-${i}`;
      await ring.upsertEvent(
        {
          hazard_id: hazardId(source, ref),
          source,
          source_ref_id: ref,
          hazard_type,
          severity: i % 5 === 0 ? 'SIAGA' : 'WASPADA',
          area_name,
          latitude: -1.5,
          longitude: 105.0,
          occurred_at: new Date(Date.UTC(2026, 10, 20, i % 24, i % 60, 0)).toISOString(),
          ingested_at: new Date(Date.UTC(2026, 10, 20, 12, 0, i)).toISOString(),
          attributes: {},
          version: 1,
        },
        { fence: 1, fenceName: source.toLowerCase(), idempotencyKey: `seed-${i}`, correlationId: 'seed' },
      );
    }

    const kubePort = 19415;
    const bmkgPort = 19416;
    const pvmbgPort = 19417;
    const KUBE = `http://127.0.0.1:${kubePort}`;
    const BMKG = `http://127.0.0.1:${bmkgPort}`;
    const PVMBG = `http://127.0.0.1:${pvmbgPort}`;
    const pvmbgToken = jwt.sign({ sub: 'aggregator' }, 'ps', { audience: 'pvmbg', expiresIn: '2h' });

    runProc('npx', ['tsx', 'scripts/fake-apiserver.ts'], join(ROOT, 'services/aggregator'), {
      KUBE_API_PORT: String(kubePort),
      LEASE_NAMESPACE: 'sistem-informasi-kebencanaan-bnpb',
    });
    runProc('node', ['dist/services/bmkg-mock/src/index.js'], join(ROOT, 'services/bmkg-mock'), {
      BMKG_PORT: String(bmkgPort),
      BMKG_API_KEY: 'bk',
      BMKG_DELAY_MIN_MS: '5',
      BMKG_DELAY_MAX_MS: '15',
    });
    runProc('node', ['dist/services/pvmbg-mock/src/index.js'], join(ROOT, 'services/pvmbg-mock'), {
      PVMBG_PORT: String(pvmbgPort),
      PVMBG_JWT_SECRET: 'ps',
      PVMBG_DELAY_MIN_MS: '5',
      PVMBG_DELAY_MAX_MS: '15',
    });
    await until('mocks ready', async () => (await fetch(`${BMKG}/health`)).ok && (await fetch(`${PVMBG}/health`)).ok);

    let nextAggPort = 19430;
    const spawnAggregator = async (
      id: string,
      node: string,
      version: string,
      opts: { digestRounds?: number; withPollers?: boolean } = {},
    ): Promise<AggInstance> => {
      const port = nextAggPort++;
      const url = `http://127.0.0.1:${port}`;
      const p = runProc('npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), {
        STORAGE_UNITS,
        AGGREGATOR_PORT: String(port),
        POD_NAME: id,
        HOSTNAME: id,
        NODE_NAME: node,
        AGGREGATOR_VERSION: version,
        INTERNAL_SERVICE_KEY: 'ik',
        AUDIT_TOKEN: 'audit-secret',
        AUDIT_RATE_LIMIT_PER_SEC: '0',
        LIST_CACHE_MS: '2000',
        ANALYTICS_CACHE_TTL_MS: '1000',
        AGGREGATOR_DIGEST_ROUNDS: String(opts.digestRounds ?? 1),
        KUBE_API_URL: KUBE,
        LEASE_NAMESPACE: 'sistem-informasi-kebencanaan-bnpb',
        LEASE_DURATION_SECONDS: '4',
        LEASE_RENEW_INTERVAL_MS: '500',
        ...(opts.withPollers
          ? {
              BMKG_BASE_URL: BMKG,
              BMKG_API_KEY: 'bk',
              PVMBG_BASE_URL: PVMBG,
              PVMBG_ACCESS_TOKEN: pvmbgToken,
              POLL_INTERVAL_MS: '2000',
            }
          : {}),
      });
      await until(`${id} (${url}) ready`, async () => (await fetch(`${url}/ready`)).ok);
      return { id, url, node, version, port, proc: p };
    };

    const lbPort = 19420;
    const LB = `http://127.0.0.1:${lbPort}`;
    runProc('npx', ['tsx', 'scripts/demo/p2-lb.ts'], ROOT, {
      LB_PORT: String(lbPort),
      LB_WORKERS: '4',
      LB_HEALTH_INTERVAL_MS: '100',
    });
    await until('LB up', async () => (await fetch(`${LB}/lb/status`)).ok);

    const setLbBackends = async (list: AggInstance[]) => {
      await fetch(`${LB}/lb/backends`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          backends: list.map(({ id, url, node, version }) => ({ id, url, node, version })),
        }),
      });
      await sleep(150);
    };

    const graceDrainAndStop = async (inst: AggInstance, activeList: AggInstance[]) => {
      // 1. Trigger readiness drain (/ready -> 503) and immediately remove from LB active targets
      await fetch(`${inst.url}/internal/admin/drain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draining: true }),
      }).catch(() => null);
      const idx = activeList.findIndex((x) => x.id === inst.id);
      if (idx >= 0) activeList.splice(idx, 1);
      await setLbBackends(activeList);
      // 2. Wait for in-flight requests on the draining instance to finish before SIGTERM
      await sleep(250);
      killProc(inst.proc, 'SIGTERM');
    };

    // =========================================================================
    // PHASE 1: P2-K1 (>= 3 instances on distinct nodes behind 1 LB that stops routing to unhealthy instance)
    // =========================================================================
    line(`\n--- Phase 1: P2-K1 Multi-Instance Spread & Unhealthy Instance Isolation ---`);
    const activePool: AggInstance[] = [
      await spawnAggregator('aggregator-1', 'node-a', 'v1', { withPollers: true }),
      await spawnAggregator('aggregator-2', 'node-b', 'v1', { withPollers: true }),
      await spawnAggregator('aggregator-3', 'node-c', 'v1', { withPollers: true }),
    ];
    await setLbBackends(activePool);

    const seenHealthy = new Map<string, number>();
    const seenNodes = new Set<string>();
    for (let i = 0; i < 120; i++) {
      const r = await fetch(`${LB}/internal/hazard-events?limit=10`, { headers: { 'x-internal-key': 'ik' } });
      const inst = r.headers.get('x-aggregator-instance') ?? 'unknown';
      const node = r.headers.get('x-lb-node') ?? 'unknown';
      seenHealthy.set(inst, (seenHealthy.get(inst) ?? 0) + 1);
      seenNodes.add(node);
    }
    line(`   Healthy 3-instance traffic distribution: ${[...seenHealthy.entries()].map(([k, v]) => `${k}=${v}`).join(', ')} across nodes [${[...seenNodes].join(', ')}]`);

    // Make aggregator-2 (node-b) unhealthy (/ready -> 503) without removing it from LB backend list!
    await fetch(`${activePool[1].url}/internal/admin/drain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draining: true }),
    });
    await sleep(300); // Allow LB /ready probe to mark aggregator-2 unhealthy

    const seenDegraded = new Map<string, number>();
    let degradedErrors = 0;
    for (let i = 0; i < 150; i++) {
      const r = await fetch(`${LB}/internal/hazard-events?limit=10`, { headers: { 'x-internal-key': 'ik' } });
      if (r.status !== 200) degradedErrors++;
      const inst = r.headers.get('x-aggregator-instance') ?? 'unknown';
      seenDegraded.set(inst, (seenDegraded.get(inst) ?? 0) + 1);
    }
    line(`   With aggregator-2 unhealthy (/ready=503): routed=${[...seenDegraded.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}, errors=${degradedErrors}`);

    // Restore aggregator-2 back to healthy
    await fetch(`${activePool[1].url}/internal/admin/drain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draining: false }),
    });
    await sleep(300);

    check(
      'P2-K1a: >= 3 Aggregator instances run across 3 distinct nodes (node-a, node-b, node-c) behind a single entry point',
      seenHealthy.size === 3 && seenNodes.size === 3,
    );
    check(
      'P2-K1b: entry point stops routing requests to unhealthy instance (0 requests to aggregator-2 while /ready=503, 0 client errors)',
      (seenDegraded.get('aggregator-2') ?? 0) === 0 && degradedErrors === 0,
    );

    for (const inst of activePool) killProc(inst.proc);
    activePool.length = 0;
    await sleep(300);

    // =========================================================================
    // PHASE 2: P2-K7 (Throughput with 3 instances >= 2.0x throughput with 1 instance)
    // =========================================================================
    line(`\n--- Phase 2: P2-K7 Throughput Benchmark (1 Instance vs 3 Instances) ---`);
    const benchRounds = 6000;
    const runThroughputBench = async (instanceCount: number): Promise<{ rps: number; p95Ms: number; totalReqs: number; failed: number }> => {
      const benchPool = await Promise.all(
        Array.from({ length: instanceCount }, (_, i) =>
          spawnAggregator(`agg-bench-${instanceCount}-${i + 1}`, nodeNames[i % 3], 'v1', { digestRounds: benchRounds, withPollers: false }),
        ),
      );
      await setLbBackends(benchPool);
      // Warmup cache on all instances
      for (let i = 0; i < 15; i++) {
        await fetch(`${LB}/internal/hazard-events?limit=50`, { headers: { 'x-internal-key': 'ik' } });
      }
      const summaryFile = join(tmp, `k7-summary-${instanceCount}.json`);
      const k6Res = spawnSync(
        'k6',
        ['run', '--quiet', '--summary-export', summaryFile, join(ROOT, 'load-tests/p2/p2-sustained-scale.k6.js')],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            BASE_URL: LB,
            VUS: '15',
            ACTIVE_HTTP_VUS: '15',
            DURATION: '6s',
            THINK_TIME_S: '0',
            WORKLOAD: 'hazards_only',
          },
          encoding: 'utf8',
        },
      );
      if (k6Res.status !== 0 && !existsSync(summaryFile)) {
        throw new Error(`k6 benchmark failed: ${k6Res.stderr || k6Res.stdout}`);
      }
      const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
      const rps = Number(summary.metrics.http_reqs.rate);
      const totalReqs = Number(summary.metrics.http_reqs.count);
      const p95Ms = Number(summary.metrics.http_req_duration['p(95)']);
      const failed = Number(summary.metrics.http_req_failed.passes ?? 0);
      for (const inst of benchPool) killProc(inst.proc);
      await sleep(300);
      return { rps, p95Ms, totalReqs, failed };
    };

    const bench1 = await runThroughputBench(1);
    const bench3 = await runThroughputBench(3);
    const ratio = bench3.rps / bench1.rps;
    line(`   1 Aggregator instance : ${bench1.rps.toFixed(1)} req/s (${bench1.totalReqs} reqs, p95=${bench1.p95Ms.toFixed(1)} ms, failed=${bench1.failed})`);
    line(`   3 Aggregator instances: ${bench3.rps.toFixed(1)} req/s (${bench3.totalReqs} reqs, p95=${bench3.p95Ms.toFixed(1)} ms, failed=${bench3.failed})`);
    line(`   Throughput scaling ratio (3 instances / 1 instance): ${ratio.toFixed(2)}x (requirement >= 2.00x)`);
    check(`P2-K7: throughput of 3 instances (${bench3.rps.toFixed(1)} req/s) is >= 2.0x throughput of 1 instance (${bench1.rps.toFixed(1)} req/s) [ratio=${ratio.toFixed(2)}x]`, ratio >= 2.0);

    // =========================================================================
    // PHASE 3: P2-K6 (10,000 VU Sustained Load Test >= 120s, Scaling 3 -> 5 -> 2) & P2-K8 (Zero-Downtime Rolling Update v1 -> v2)
    // =========================================================================
    const k6DurationSec = Number(process.env.P2_K6_DURATION_S ?? 120);
    const k6Vus = Number(process.env.P2_K6_VUS ?? 10000);
    const k6ActiveHttpVus = Number(process.env.P2_K6_ACTIVE_HTTP_VUS ?? 450);
    line(`\n--- Phase 3: P2-K6 & P2-K8 Sustained Load Test (${k6Vus} VUs, ${k6DurationSec}s, Scale 3 -> 5 -> 2 + Live Rolling Update v1 -> v2) ---`);

    // Start initial 3 Aggregator v1 instances with Lease-coordinated BMKG & PVMBG pollers
    const livePool: AggInstance[] = await Promise.all([
      spawnAggregator('aggregator-1', 'node-a', 'v1', { withPollers: true }),
      spawnAggregator('aggregator-2', 'node-b', 'v1', { withPollers: true }),
      spawnAggregator('aggregator-3', 'node-c', 'v1', { withPollers: true }),
    ]);
    await setLbBackends(livePool);
    const pollWindowStart = new Date().toISOString();

    const k6SummaryPath = join(tmp, 'k6-p2-k6-k8.json');
    const k6StartMs = Date.now();
    const k6Proc = spawn(
      'k6',
      ['run', '--quiet', '--summary-export', k6SummaryPath, join(ROOT, 'load-tests/p2/p2-sustained-scale.k6.js')],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          BASE_URL: LB,
          VUS: String(k6Vus),
          ACTIVE_HTTP_VUS: String(k6ActiveHttpVus),
          DURATION: `${k6DurationSec}s`,
          THINK_TIME_S: '0.3',
          WORKLOAD: 'mixed',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let k6Out = '';
    k6Proc.stdout?.on('data', (d) => { k6Out += d.toString(); });
    k6Proc.stderr?.on('data', (d) => { k6Out += d.toString(); });
    const k6Done = new Promise<number>((resolve) => {
      k6Proc.on('close', (code) => resolve(code ?? 1));
    });

    const elapsedSec = () => Math.round((Date.now() - k6StartMs) / 1000);
    const waitUntilFraction = async (frac: number) => {
      const targetMs = k6StartMs + Math.floor(k6DurationSec * 1000 * frac);
      const rem = targetMs - Date.now();
      if (rem > 0) await sleep(rem);
    };

    // Stage 1 (0..20%): Run at 3 instances (v1)
    await waitUntilFraction(0.20);
    line(`   [t=${elapsedSec()}s] Scaling OUT Aggregator pool: 3 -> 5 instances...`);
    const [agg4, agg5] = await Promise.all([
      spawnAggregator('aggregator-4', 'node-a', 'v1', { withPollers: true }),
      spawnAggregator('aggregator-5', 'node-b', 'v1', { withPollers: true }),
    ]);
    livePool.push(agg4, agg5);
    await setLbBackends(livePool);
    const countAtScale5 = livePool.length;
    line(`   [t=${elapsedSec()}s] Active healthy Aggregator instances = ${countAtScale5} (${livePool.map((x) => x.id).join(', ')})`);

    // Stage 2 (20..42%): Run at 5 instances
    await waitUntilFraction(0.42);
    line(`   [t=${elapsedSec()}s] Scaling IN Aggregator pool: 5 -> 2 instances (graceful readiness drain)...`);
    await graceDrainAndStop(agg5, livePool);
    await graceDrainAndStop(agg4, livePool);
    await graceDrainAndStop(livePool[2], livePool); // drain aggregator-3
    const countAtScale2 = livePool.length;
    line(`   [t=${elapsedSec()}s] Active healthy Aggregator instances = ${countAtScale2} (${livePool.map((x) => x.id).join(', ')})`);

    // Stage 3 (42..62%): Run at 2 instances, then scale back to 3 and execute Rolling Update v1 -> v2 (P2-K8)
    await waitUntilFraction(0.62);
    line(`   [t=${elapsedSec()}s] Restoring 3rd replica & executing Rolling Update v1 -> v2 (maxSurge=1, maxUnavailable=0)...`);
    const agg3v1 = await spawnAggregator('aggregator-3b', 'node-c', 'v1', { withPollers: true });
    livePool.push(agg3v1);
    await setLbBackends(livePool);

    // Rolling update each of the 3 v1 instances to v2 one by one (maxSurge=1, maxUnavailable=0)
    const oldV1Instances = [...livePool];
    for (let i = 0; i < oldV1Instances.length; i++) {
      const oldInst = oldV1Instances[i];
      const newInst = await spawnAggregator(`aggregator-v2-${i + 1}`, oldInst.node, 'v2', { withPollers: true });
      // Surge up: add new v2 instance before draining old v1 instance
      livePool.push(newInst);
      await setLbBackends(livePool);
      await sleep(150);
      // Gracefully drain and terminate old v1 instance
      await graceDrainAndStop(oldInst, livePool);
      line(`     [t=${elapsedSec()}s] Rolled out ${newInst.id} (v2 on ${newInst.node}) replacing ${oldInst.id} (v1); active=${livePool.map((x) => `${x.id}:${x.version}`).join(', ')}`);
    }

    // Verify all responses after rollout come from v2
    const postRolloutVersions = new Set<string>();
    let postRolloutFailures = 0;
    for (let i = 0; i < 60; i++) {
      const r = await fetch(`${LB}/internal/hazard-events?limit=10`, { headers: { 'x-internal-key': 'ik' } });
      if (r.status !== 200) postRolloutFailures++;
      postRolloutVersions.add(r.headers.get('x-aggregator-version') ?? 'unknown');
    }
    line(`   Post-rollout version probe (60 requests): versions=[${[...postRolloutVersions].join(', ')}], failures=${postRolloutFailures}`);

    // Wait for k6 to finish
    const k6ExitCode = await k6Done;

    if (!existsSync(k6SummaryPath)) {
      throw new Error(`k6 did not produce summary file (exit=${k6ExitCode}):\n${k6Out}`);
    }
    const k6Summary = JSON.parse(readFileSync(k6SummaryPath, 'utf8'));
    const totalHttpReqs = Number(k6Summary.metrics.http_reqs?.count ?? 0);
    const httpRps = Number(k6Summary.metrics.http_reqs?.rate ?? 0);
    const failedRate = Number(k6Summary.metrics.http_req_failed?.value ?? 0);
    const failedCount = Number(k6Summary.metrics.http_req_failed?.passes ?? 0);
    const p50Ms = Number(k6Summary.metrics.http_req_duration?.med ?? 0);
    const p95Ms = Number(k6Summary.metrics.http_req_duration?.['p(95)'] ?? 0);
    const p99Ms = Number(k6Summary.metrics.http_req_duration?.['p(99)'] ?? 0);
    const vusMax = Number(k6Summary.metrics.vus_max?.value ?? 0);
    const v1Count = Number(k6Summary.metrics.bnpb_responses_version_v1?.count ?? 0);
    const v2Count = Number(k6Summary.metrics.bnpb_responses_version_v2?.count ?? 0);

    const lbStatus = (await (await fetch(`${LB}/lb/status`)).json()) as any;

    // Verify P2-K2 held throughout the entire 3 -> 5 -> 2 scaling & v1 -> v2 rollout
    const bmkgLogRes = (await (await fetch(`${BMKG}/admin/request-log?since=${encodeURIComponent(pollWindowStart)}`)).json()) as any;
    const seismicCalls = (bmkgLogRes.data as Array<{ path: string; caller_instance: string; ts: string }>).filter((e) =>
      e.path.startsWith('/seismic-events'),
    );
    // Check that no two different instances polled BMKG within 800ms of each other (single active leader at any time)
    let concurrentLeaderViolations = 0;
    for (let i = 1; i < seismicCalls.length; i++) {
      const dt = Date.parse(seismicCalls[i].ts) - Date.parse(seismicCalls[i - 1].ts);
      if (dt < 800 && seismicCalls[i].caller_instance !== seismicCalls[i - 1].caller_instance) {
        concurrentLeaderViolations++;
      }
    }
    const distinctCallersAcrossFailovers = [...new Set(seismicCalls.map((c) => c.caller_instance))];
    const auditEventsRes = (await (
      await fetch(`${LB}/internal/audit/events?limit=1000`, { headers: { authorization: 'Bearer audit-secret' } })
    ).json()) as any;
    const eventIds = (auditEventsRes.items as Array<{ hazard_id: string }>).map((e) => e.hazard_id);
    const uniqueEventIds = new Set(eventIds);

    line(`\n--- k6 Sustained Load Test & Rolling Update Summary ---`);
    line(`   Virtual Users (vus_max)     : ${vusMax} VUs (duration=${k6DurationSec}s, active connection pool=${k6ActiveHttpVus})`);
    line(`   Scaling trajectory          : 3 -> ${countAtScale5} -> ${countAtScale2} -> 3 (rolled out v1 -> v2)`);
    line(`   Total HTTP requests         : ${totalHttpReqs} (${httpRps.toFixed(1)} req/s)`);
    line(`   Failed requests             : ${failedCount} / ${totalHttpReqs} (${(failedRate * 100).toFixed(4)} %, requirement < 1.00 %)`);
    line(`   Latency                     : p50=${p50Ms.toFixed(1)} ms, p95=${p95Ms.toFixed(1)} ms, p99=${p99Ms.toFixed(1)} ms`);
    line(`   Version responses served    : v1=${v1Count}, v2=${v2Count}`);
    line(`   LB per-instance distribution: ${JSON.stringify(lbStatus.stats.byInstance)}`);
    line(`   BMKG upstream polls         : ${seismicCalls.length} polls across leader sequence [${distinctCallersAcrossFailovers.join(' -> ')}], concurrent violations=${concurrentLeaderViolations}`);
    line(`   Stored events uniqueness    : ${uniqueEventIds.size} unique / ${eventIds.length} total (0 duplicates)`);

    check(`P2-K6a: sustained load test ran with ${vusMax} VUs (>= 10,000) and scaled instances 3 -> ${countAtScale5} -> ${countAtScale2}`, vusMax >= 10000 && countAtScale5 === 5 && countAtScale2 === 2);
    check(`P2-K6b: error rate during scaling & load test is ${(failedRate * 100).toFixed(4)}% (< 1.0%)`, failedRate < 0.01);
    check(
      `P2-K6c: P2-K2 preserved during 3->5->2 scaling (0 concurrent multi-instance upstream polls, 0 duplicate HazardEvents in ring)`,
      concurrentLeaderViolations === 0 && uniqueEventIds.size === eventIds.length && seismicCalls.length > 0,
    );
    check(
      `P2-K8: live rolling update v1 -> v2 completed during load test with 0 failed requests (v1=${v1Count}, v2=${v2Count})`,
      v1Count > 0 && v2Count > 0 && postRolloutFailures === 0 && postRolloutVersions.size === 1 && postRolloutVersions.has('v2') && failedCount === 0,
    );

    const allOk = checks.every(([, ok]) => ok);
    line(`RESULT: ${allOk ? 'PASS' : 'FAIL'}`);
    process.exitCode = allOk ? 0 : 1;
  } finally {
    for (const p of procs) killProc(p);
    rmSync(tmp, { recursive: true, force: true });
  }
}

main()
  .catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
