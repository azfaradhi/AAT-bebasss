// P1 demo on real processes: three storage units, load, sebaran, kill one with its disk, repair, kill another.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { hazardId } from '../../shared-types/src/m2/ids';
import type { HazardSource, StoredHazardEvent } from '../../shared-types/src/m2/types';

const N = Number(process.env.DEMO_EVENTS ?? 3000);
const base = 18100;
const root = mkdtempSync(join(tmpdir(), 'ring-demo-'));
const procs = new Map<string, ChildProcess>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ctx = { fence: 1, idempotencyKey: 'demo', correlationId: 'demo', fenceName: 'demo' };

function start(name: string, port: number, fresh: boolean): void {
  const dir = join(root, name);
  if (fresh) rmSync(dir, { recursive: true, force: true });
  const p = spawn('node', ['dist/services/storage-unit/src/index.js'], {
    cwd: join(__dirname, '../../services/storage-unit'),
    env: { ...process.env, STORAGE_UNIT_PORT: String(port), STORAGE_UNIT_ID: name, NODE_NAME: name.replace('unit-', 'node-'), STORAGE_DATA_DIR: dir },
    stdio: 'ignore',
    detached: true,
  });
  procs.set(name, p);
}
async function kill(name: string): Promise<void> {
  const p = procs.get(name)!;
  try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ }
  await new Promise((r) => p.once('exit', r));
}
const line = (s: string) => process.stdout.write(s + '\n');

async function main(): Promise<void> {
  const names = ['unit-a', 'unit-b', 'unit-c'];
  names.forEach((n, i) => start(n, base + i, true));
  const urls = names.map((_, i) => `http://127.0.0.1:${base + i}`);
  const units = await discoverUnits({ STORAGE_UNITS: urls.join(',') }, 15);
  // Fresh units start JOINING; a cold start merges them and marks them STABLE.
  const client = new HttpStorageClient({ units, stateTtlMs: 0 });
  await client.repair();
  line(`units: ${units.map((u) => `${u.unit}@${u.node}`).join(', ')}`);

  const t0 = Date.now();
  for (let i = 0; i < N; i += 50) {
    await Promise.all(Array.from({ length: Math.min(50, N - i) }, (_, k) => {
      const ref = `eq-${i + k}`;
      const e: StoredHazardEvent = {
        hazard_id: hazardId('BMKG' as HazardSource, ref), source: 'BMKG', source_ref_id: ref, hazard_type: 'SEISMIC', severity: 'WASPADA',
        area_name: `Area-${(i + k) % 40}`, latitude: -2, longitude: 113, occurred_at: new Date(Date.UTC(2026, 10, 12, 0, 0, (i + k) % 3600)).toISOString(),
        ingested_at: new Date(Date.UTC(2026, 10, 12, 3, 0, 0, i + k)).toISOString(), attributes: {}, version: 1,
      };
      return client.upsertEvent(e, ctx);
    }));
  }
  line(`loaded ${N} events in ${Date.now() - t0} ms`);

  const st = await client.ringStatus();
  const total = st.units.reduce((a, u) => a + u.keys, 0);
  for (const u of st.units) line(`  ${u.unit} (${u.node}): ${u.keys} keys (${((u.keys / total) * 100).toFixed(1)}%)`);
  const base0 = await client.checksum('BMKG');
  line(`checksum before: count=${base0.count} sha256=${base0.checksum.slice(0, 16)}… partial=${base0.partial}`);

  // Start a real aggregator HTTP host and run a continuous concurrent reader loop across the entire kill -> wipe -> empty restart -> repair -> 2nd unit kill lifecycle (P1-K4: 0 x HTTP 500, 0 hangs)
  const aggPort = base + 20;
  const AGG = `http://127.0.0.1:${aggPort}`;
  const aggProc = spawn('npx', ['tsx', 'scripts/ring-host.ts'], {
    cwd: join(__dirname, '../../services/aggregator'),
    env: { ...process.env, STORAGE_UNITS: urls.join(','), AGGREGATOR_PORT: String(aggPort), INTERNAL_SERVICE_KEY: 'ik', AUDIT_TOKEN: 'audit-secret', STORAGE_STATE_TTL_MS: '50', LIST_CACHE_MS: '0' },
    stdio: 'ignore',
    detached: true,
  });
  procs.set('agg', aggProc);
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${AGG}/ready`).then((r) => r.ok).catch(() => false)) break;
    await sleep(100);
  }

  let stopHammer = false;
  let hammerReqs = 0;
  let hammer500s = 0;
  let hammerHangs = 0;
  let hammerPartialSeen = 0;
  const hammerLoop = (async () => {
    while (!stopHammer) {
      hammerReqs++;
      try {
        const r1 = await fetch(`${AGG}/internal/audit/events?limit=20`, { headers: { authorization: 'Bearer audit-secret' }, signal: AbortSignal.timeout(2500) });
        if (r1.status >= 500) hammer500s++;
        const b1 = (await r1.json()) as any;
        if (b1?.partial) hammerPartialSeen++;

        const r2 = await fetch(`${AGG}/internal/hazard-events?limit=20`, { headers: { 'x-internal-key': 'ik' }, signal: AbortSignal.timeout(2500) });
        if (r2.status >= 500) hammer500s++;
      } catch {
        hammerHangs++;
      }
      await sleep(25);
    }
  })();

  await kill('unit-b');
  start('unit-b', base + 1, true);
  await sleep(500);
  const mid = await client.checksum('BMKG');
  line(`unit-b killed (SIGKILL) and its disk wiped, restarted empty: count=${mid.count} same_checksum=${mid.checksum === base0.checksum} partial=${mid.partial}`);
  line(`  redundancy_ok during recovery: ${(await client.ringStatus()).redundancy_ok}`);

  const r = await client.repair();
  const after = await client.ringStatus();
  line(`repair: ${JSON.stringify(r.repaired)}; redundancy_ok=${after.redundancy_ok}; unit-b keys=${after.units.find((u) => u.unit === 'unit-b')!.keys}`);

  await kill('unit-c');
  const second = await client.checksum('BMKG');
  const page = await client.listEvents({ limit: 50 });
  line(`unit-c then killed: count=${second.count} same_checksum=${second.checksum === base0.checksum} partial=${second.partial}; list(50)=${page.items.length}`);

  // Also test 2-units-down partial window during continuous traffic, then stop hammer loop
  await kill('unit-b');
  await sleep(350);
  stopHammer = true;
  await hammerLoop;
  line(`continuous HTTP queries during kill/wipe/recovery/degraded window: total=${hammerReqs}, http_500=${hammer500s}, hangs=${hammerHangs}, partial_flagged_responses=${hammerPartialSeen}`);
  const ok = mid.checksum === base0.checksum && second.checksum === base0.checksum && !second.partial && after.redundancy_ok && second.count === N && hammer500s === 0 && hammerHangs === 0 && hammerPartialSeen > 0;
  line(ok ? 'RESULT: PASS (no event lost; survives a second loss after repair)' : 'RESULT: FAIL');
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs.values()) { try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ } } rmSync(root, { recursive: true, force: true }); });
