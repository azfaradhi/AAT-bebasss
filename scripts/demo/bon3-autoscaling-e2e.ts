// BON-3 (MB2-C1): Real-Process Self-Adjusting Capacity (Autoscaling) Verification.
// Demonstrates the Aggregator pool automatically scaling OUT (3 -> 5 instances) when traffic surges above the 70% utilization target,
// and automatically scaling IN (5 -> 3 instances) after the stabilization window when traffic subsides, with 0 failed requests.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HpaController, parsePrometheusHttpRequestCount } from '../../services/aggregator/src/autoscaler/hpa-controller';
import { hazardId } from '../../shared-types/src/m2/ids';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';
import type { BackendSpec } from './p2-lb';

const ROOT = join(__dirname, '../..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => {
  checks.push([name, ok]);
  line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
};

async function until(what: string, fn: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${what}`);
}

interface AggProc extends BackendSpec {
  proc: ChildProcess;
  lastReqCount: number;
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'bon3-'));
  const procs = new Set<ChildProcess>();
  const runProc = (cmd: string, args: string[], cwd: string, env: Record<string, string>) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore', detached: true });
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
    line(`=== BON-3 (MB2-C1): Self-Adjusting Capacity (Autoscaling 3 -> 5 -> 3 Replicas Following Load) ===`);
    const unitPorts = [19710, 19711, 19712];
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
    const ring = new HttpStorageClient({ units: await discoverUnits({ STORAGE_UNITS }, 25), rf: 2, vnodes: 64, stateTtlMs: 0 });
    await ring.repair();

    for (let i = 0; i < 60; i++) {
      const ref = `BON3-${i}`;
      await ring.upsertEvent(
        {
          hazard_id: hazardId('BMKG', ref),
          source: 'BMKG',
          source_ref_id: ref,
          hazard_type: 'SEISMIC',
          severity: 'WASPADA',
          area_name: 'Sumatera Barat',
          latitude: -0.9,
          longitude: 100.3,
          occurred_at: new Date(Date.UTC(2026, 10, 20, 0, i, 0)).toISOString(),
          ingested_at: new Date(Date.UTC(2026, 10, 20, 0, i, 0)).toISOString(),
          attributes: {},
          version: 1,
        },
        { fence: 1, fenceName: 'bmkg', idempotencyKey: `bon3-${i}`, correlationId: 'bon3' },
      );
    }

    const lbPort = 19720;
    const LB = `http://127.0.0.1:${lbPort}`;
    runProc('npx', ['--prefix', 'services/aggregator', 'tsx', 'scripts/demo/p2-lb.ts'], ROOT, {
      LB_PORT: String(lbPort),
      LB_WORKERS: '2',
      LB_HEALTH_INTERVAL_MS: '100',
    });
    await until('LB ready', async () => (await fetch(`${LB}/lb/status`)).ok);

    let nextPort = 19730;
    let nextSeq = 1;
    const spawnReplica = async (): Promise<AggProc> => {
      const idx = nextSeq++;
      const id = `aggregator-${idx}`;
      const node = nodeNames[(idx - 1) % 3];
      const port = nextPort++;
      const url = `http://127.0.0.1:${port}`;
      const p = runProc('npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), {
        STORAGE_UNITS,
        AGGREGATOR_PORT: String(port),
        POD_NAME: id,
        NODE_NAME: node,
        INTERNAL_SERVICE_KEY: 'ik',
        AUDIT_TOKEN: 'audit-secret',
        LIST_CACHE_MS: '2000',
      });
      await until(`${id} ready`, async () => (await fetch(`${url}/ready`)).ok);
      const mText = await (await fetch(`${url}/metrics`)).text();
      return { id, url, node, version: 'v1', proc: p, lastReqCount: parsePrometheusHttpRequestCount(mText) };
    };

    const syncLb = async (pool: AggProc[]) => {
      await fetch(`${LB}/lb/backends`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ backends: pool.map(({ id, url, node, version }) => ({ id, url, node, version })) }),
      });
    };

    const pool: AggProc[] = [await spawnReplica(), await spawnReplica(), await spawnReplica()];
    await syncLb(pool);

    // Policy mirrors deploy/k8s/aggregator/hpa.yaml: minReplicas=3, maxReplicas=5, targetAverageUtilization=70%
    // (100 req/s = 100% per replica capacity -> 70 req/s per replica = 70% target utilization; stabilizationWindow=3s for fast demo)
    const hpa = new HpaController({
      minReplicas: 3,
      maxReplicas: 5,
      maxCapacityPerReplica: 100,
      targetAverageUtilizationPct: 70,
      scaleDownStabilizationMs: 3000,
    });

    let targetTotalRps = 90; // Phase 1: 90 req/s across 3 replicas = 30 req/s/replica (30% utilization < 70%)
    let stopTraffic = false;
    let totalSent = 0;
    let totalFailed = 0;

    // Background traffic driver pacing requests at targetTotalRps
    const trafficLoop = (async () => {
      while (!stopTraffic) {
        const batch = Math.max(1, Math.round(targetTotalRps / 10));
        await Promise.all(
          Array.from({ length: batch }, async () => {
            totalSent++;
            try {
              const r = await fetch(`${LB}/internal/hazard-events?limit=20`, { headers: { 'x-internal-key': 'ik' } });
              if (r.status !== 200) totalFailed++;
            } catch {
              totalFailed++;
            }
          }),
        );
        await sleep(100);
      }
    })();

    const timeline: Array<{ sec: number; phase: string; targetRps: number; avgUtil: number; replicasBefore: number; replicasAfter: number; action: string }> = [];
    line(`\nTime | Phase            | Target Load | Avg Replica Load | Avg Util % | Replicas | HPA Action`);
    line(`-------------------------------------------------------------------------------------------------`);

    for (let sec = 1; sec <= 12; sec++) {
      const phase = sec <= 3 ? '1. Baseline Low' : sec <= 7 ? '2. Traffic Surge' : '3. Cool-down';
      targetTotalRps = sec <= 3 ? 90 : sec <= 7 ? 380 : 90;
      await sleep(1000);

      // Scrape /metrics from each active replica to measure per-replica req/s over the last 1s window
      const rates = await Promise.all(
        pool.map(async (inst) => {
          const text = await (await fetch(`${inst.url}/metrics`)).text();
          const cur = parsePrometheusHttpRequestCount(text);
          const delta = Math.max(0, cur - inst.lastReqCount);
          inst.lastReqCount = cur;
          return delta;
        }),
      );

      const before = pool.length;
      const ev = hpa.evaluate(before, rates);

      if (ev.action === 'scale_up') {
        const toAdd = ev.desiredReplicasStabilized - before;
        for (let k = 0; k < toAdd; k++) {
          pool.push(await spawnReplica());
        }
        await syncLb(pool);
      } else if (ev.action === 'scale_down') {
        const toRemove = before - ev.desiredReplicasStabilized;
        for (let k = 0; k < toRemove; k++) {
          const victim = pool.pop()!;
          await fetch(`${victim.url}/internal/admin/drain`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ draining: true }),
          }).catch(() => null);
          await syncLb(pool);
          await sleep(150);
          killProc(victim.proc, 'SIGTERM');
        }
      }

      const after = pool.length;
      timeline.push({ sec, phase, targetRps: targetTotalRps, avgUtil: ev.averageUtilizationPct, replicasBefore: before, replicasAfter: after, action: ev.action });
      line(
        `t=${String(sec).padStart(2)}s | ${phase.padEnd(16)} | ${String(targetTotalRps).padStart(7)} r/s | ${String(ev.averageValuePerReplica).padStart(12)} r/s | ${String(ev.averageUtilizationPct).padStart(8)} % |  ${before} -> ${after}  | ${ev.action}`,
      );
    }

    stopTraffic = true;
    await trafficLoop;

    const maxReached = Math.max(...timeline.map((t) => t.replicasAfter));
    const finalReplicas = timeline[timeline.length - 1].replicasAfter;
    const scaledUpDuringSurge = timeline.some((t) => t.phase.startsWith('2.') && t.replicasAfter === 5);
    const scaledDownAfterCooldown = timeline.filter((t) => t.phase.startsWith('3.')).some((t) => t.action === 'scale_down') && finalReplicas === 3;

    line(`\nAutoscaling summary: total HTTP requests=${totalSent}, failed=${totalFailed}, replica trajectory=${timeline.map((t) => t.replicasAfter).join('->')}`);
    check('BON-3a: capacity automatically scaled OUT from 3 to 5 instances when load rose above 70% target utilization', scaledUpDuringSurge && maxReached === 5);
    check('BON-3b: capacity automatically scaled IN from 5 back to 3 instances after load dropped and stabilization window elapsed', scaledDownAfterCooldown);
    check(`BON-3c: 0 failed requests during automatic scale-up and scale-down (${totalFailed}/${totalSent} failed)`, totalFailed === 0);

    const allOk = checks.every(([, ok]) => ok);
    line(`RESULT: ${allOk ? 'PASS' : 'FAIL'}`);
    process.exitCode = allOk ? 0 : 1;
  } finally {
    for (const p of procs) killProc(p);
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exitCode = 1;
});
