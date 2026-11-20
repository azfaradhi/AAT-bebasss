// P1-K5/K6 on real processes: a fourth storage unit joins a running ring while reads and writes continue; it takes data and load; then an original unit is lost.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeChecksum, hazardId } from '../../shared-types/src/m2/ids';
import type { HazardEvent } from '../../shared-types/src/m2/types';
import { GatewayStorageClient } from '../../shared-types/src/ring/gateway-client';

const ROOT = join(__dirname, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'join-'));
const procs = new Map<string, ChildProcess>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };
const killGroup = (p: ChildProcess) => { try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ } };
function run(name: string, cmd: string, args: string[], cwd: string, env: Record<string, string>): void {
  procs.set(name, spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: process.env.DEMO_LOGS ? 'inherit' : 'ignore', detached: true }));
}
async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(200);
  }
}

async function main(): Promise<void> {
  const ports = [18710, 18711, 18712, 18713];
  const names = ['unit-a', 'unit-b', 'unit-c', 'unit-d'];
  const startUnit = (i: number) => run(names[i], 'node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), { STORAGE_UNIT_PORT: String(ports[i]), STORAGE_UNIT_ID: names[i], NODE_NAME: names[i].replace('unit-', 'node-'), STORAGE_DATA_DIR: join(tmp, names[i]) });
  const url = (i: number) => `http://127.0.0.1:${ports[i]}`;
  const file = join(tmp, 'units.txt');
  writeFileSync(file, [0, 1, 2].map(url).join(','));
  [0, 1, 2].forEach(startUnit);
  await until('units up', async () => (await Promise.all([0, 1, 2].map((i) => fetch(`${url(i)}/u/identity`)))).every((r) => r.ok));
  run('host', 'npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), { STORAGE_UNITS_FILE: file, AGGREGATOR_PORT: '18720', INTERNAL_SERVICE_KEY: 'ik', STORAGE_STATE_TTL_MS: '200', STORAGE_REPAIR_INTERVAL_MS: '500', STORAGE_MEMBERSHIP_INTERVAL_MS: '500' });
  const store = new GatewayStorageClient({ baseUrl: 'http://127.0.0.1:18720', internalServiceKey: 'ik', timeoutMs: 5000 });
  await until('host up', async () => (await store.ringStatus()).units.length === 3);
  await until('ring stable', async () => (await store.ringStatus()).units.every((u) => u.state === 'STABLE') || (await sleep(500), false));

  const ctx = { fence: 1, fenceName: 'join', idempotencyKey: 'join', correlationId: 'join' };
  const written: string[] = [];
  let writeFails = 0, readFails = 0, ops = 0, seq = 0;
  const mk = (ref: string): HazardEvent => ({
    hazard_id: hazardId('BMKG', ref), source: 'BMKG', source_ref_id: ref, hazard_type: 'SEISMIC', severity: 'WASPADA', occurred_at: new Date(Date.UTC(2026, 10, 15, 0, 0, seq % 3600)).toISOString(),
    area_name: `area-${seq % 9}`, coordinates: { latitude: -6, longitude: 106 }, description: 'join demo',
  });
  for (; seq < 1500; seq++) { const ref = `seed-${seq}`; await store.upsertEvent(mk(ref), ctx); written.push(ref); }
  const before = await store.ringStatus();
  line(`before: ${before.units.map((u) => `${u.unit}=${u.keys} keys`).join(', ')} (redundancy_ok=${before.redundancy_ok})`);

  // Continuous load for the whole join: one writer and one reader, every failure counted.
  let stop = false;
  const writer = (async () => { while (!stop) { const ref = `live-${seq++}`; try { await store.upsertEvent(mk(ref), ctx); written.push(ref); } catch { writeFails++; } ops++; await sleep(5); } })();
  const reader = (async () => { while (!stop) { const ref = written[Math.floor(Math.random() * written.length)]; try { const r = await store.getEvent(hazardId('BMKG', ref)); if (!r.event) readFails++; } catch { readFails++; } ops++; await sleep(5); } })();
  await sleep(1500);

  startUnit(3);
  await until('unit-d up', async () => (await fetch(`${url(3)}/u/identity`)).ok);
  const joinStart = Date.now();
  appendFileSync(file, `,${url(3)}`);
  const joined = await until('unit-d joined and STABLE', async () => { const s = await store.ringStatus(); const d = s.units.find((u) => u.unit === 'unit-d'); return d && d.state === 'STABLE' ? s : null; }, 60_000);
  line(`unit-d announced via the units file, STABLE after ${Date.now() - joinStart} ms`);
  const dWritesAtJoin = joined.units.find((u) => u.unit === 'unit-d')!.writes_total;
  await sleep(4000);
  stop = true; await Promise.all([writer, reader]);

  const after = await store.ringStatus();
  const d = after.units.find((u) => u.unit === 'unit-d')!;
  line(`after:  ${after.units.map((u) => `${u.unit}=${u.keys} keys`).join(', ')}; ${written.length} events written, ${ops} operations during the run`);
  check(`no failed write and no failed/missing read during the join (${writeFails} write failures, ${readFails} read failures)`, writeFails === 0 && readFails === 0);
  check('ring now has four units, all STABLE, redundancy_ok', after.units.length === 4 && after.units.every((u) => u.state === 'STABLE') && after.redundancy_ok);
  const share = d.keys / (written.length * 2);
  check(`new unit holds its share of the data (${d.keys} of ${written.length * 2} replica copies = ${(share * 100).toFixed(1)} %, ideal 25 %)`, share > 0.15 && share < 0.35);
  check(`new unit takes write load after joining (writes ${dWritesAtJoin} -> ${d.writes_total})`, d.writes_total > dWritesAtJoin);
  const total = await store.checksum('BMKG');
  check(`checksum over all ${written.length} written events is complete and equals an independent computation`, total.count === written.length && total.checksum === computeChecksum(written) && !total.partial);

  // K6: lose an original unit after the join.
  const a = procs.get('unit-a')!; killGroup(a); await new Promise((r) => a.once('exit', r));
  const lost = await store.checksum('BMKG');
  check('original unit-a killed after the join: nothing lost, not partial', lost.count === written.length && lost.checksum === total.checksum && !lost.partial);
  const w = await store.upsertEvent(mk(`after-kill-${seq++}`), ctx);
  check('writes still accepted with unit-a down', w.replicas_acked >= 1);

  line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs.values()) killGroup(p); rmSync(tmp, { recursive: true, force: true }); });
