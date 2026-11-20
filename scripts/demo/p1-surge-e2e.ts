// P1-K2 on real processes: per-unit load while a dataset loads, and while one region has a burst of events.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hazardId } from '../../shared-types/src/m2/ids';
import type { HazardEvent } from '../../shared-types/src/m2/types';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';

const ROOT = join(__dirname, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'surge-'));
const procs: ChildProcess[] = [];
const line = (s: string) => process.stdout.write(s + '\n');
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };

async function main(): Promise<void> {
  const ports = [18810, 18811, 18812];
  ports.forEach((p, i) => procs.push(spawn('node', ['dist/services/storage-unit/src/index.js'], { cwd: join(ROOT, 'services/storage-unit'), detached: true, stdio: 'ignore', env: { ...process.env, STORAGE_UNIT_PORT: String(p), STORAGE_UNIT_ID: `unit-${i}`, NODE_NAME: `node-${i}`, STORAGE_DATA_DIR: join(tmp, `u${i}`) } })));
  const ring = new HttpStorageClient({ units: await discoverUnits({ STORAGE_UNITS: ports.map((p) => `http://127.0.0.1:${p}`).join(',') }, 20), stateTtlMs: 0 });
  await ring.repair();
  const ctx = { fence: 1, fenceName: 'surge', idempotencyKey: 's', correlationId: 's' };
  const snapshot = async () => Object.fromEntries((await ring.ringStatus()).units.map((u) => [u.unit, u.writes_total]));
  const delta = (a: Record<string, number>, b: Record<string, number>) => Object.keys(b).map((k) => b[k] - (a[k] ?? 0));
  const spread = (xs: number[]) => (Math.max(...xs) - Math.min(...xs)) / (xs.reduce((s, x) => s + x, 0) / xs.length);
  const ev = (ref: string, i: number, area: string, lat: number, lon: number): HazardEvent => ({
    hazard_id: hazardId('BMKG', ref), source: 'BMKG', source_ref_id: ref, hazard_type: 'SEISMIC', severity: 'WASPADA',
    occurred_at: new Date(Date.UTC(2026, 10, 15, 0, 0, i % 3600)).toISOString(), area_name: area, coordinates: { latitude: lat, longitude: lon }, description: 'surge demo',
  });

  const AREAS = ['Aceh', 'Sumut', 'Jabar', 'Jateng', 'NTT', 'Sulteng', 'Maluku', 'Papua'];
  const s0 = await snapshot();
  for (let i = 0; i < 3000; i++) await ring.upsertEvent(ev(`ds-${i}`, i, AREAS[i % AREAS.length], -8 + (i % 80) / 10, 95 + (i % 400) / 4), ctx);
  const s1 = await snapshot();
  const load = delta(s0, s1);
  line(`dataset load (3000 events, 8 regions): writes per unit = ${load.join(' / ')}  (imbalance ${(spread(load) * 100).toFixed(1)} % of mean)`);

  // Burst: 3000 events from ONE region (same area_name, a few km apart, within one hour).
  for (let i = 0; i < 3000; i++) await ring.upsertEvent(ev(`burst-${i}`, i % 3600, 'Palu, Sulawesi Tengah', -0.9 + (i % 50) / 5000, 119.85 + (i % 50) / 5000), ctx);
  const s2 = await snapshot();
  const burst = delta(s1, s2);
  line(`one-region burst (3000 events, all "Palu"): writes per unit = ${burst.join(' / ')}  (imbalance ${(spread(burst) * 100).toFixed(1)} % of mean)`);

  check('dataset load: no unit carries more than 1.15x or less than 0.85x of the mean share', Math.max(...load) / (6000 / 3) < 1.15 && Math.min(...load) / (6000 / 3) > 0.85);
  check('one-region burst: same bound holds (placement keys on hazard_id, not on area or time)', Math.max(...burst) / (6000 / 3) < 1.15 && Math.min(...burst) / (6000 / 3) > 0.85);
  const status = await ring.ringStatus();
  check('no unit holds all data (every unit holds fewer keys than the 6000 events)', status.units.every((u) => u.keys < 6000));
  line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs) { try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ } } rmSync(tmp, { recursive: true, force: true }); });
