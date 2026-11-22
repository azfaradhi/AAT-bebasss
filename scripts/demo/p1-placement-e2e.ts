// P1-K1 (spek M2-2): the data is partitioned into units, no unit holds everything, primary (write load) is spread over more than one node, and a unit's replica sits on another node.
// Real processes: 3 storage-unit (3 "nodes"), aggregator host; reads /internal/audit/placement and /internal/audit/location.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hazardId } from '../../shared-types/src/m2/ids';
import type { StoredHazardEvent } from '../../shared-types/src/m2/types';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';

const ROOT = join(__dirname, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'plc-'));
const procs: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };
const run = (cmd: string, args: string[], cwd: string, env: Record<string, string>) => { const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: process.env.DEMO_LOGS ? 'inherit' : 'ignore', detached: true }); procs.push(p); };
async function until<T>(fn: () => Promise<T | null | false>, ms = 60_000): Promise<T> { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await sleep(200); } }

async function main(): Promise<void> {
  const ports = [19410, 19411, 19412];
  ports.forEach((p, i) => run('node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), { STORAGE_UNIT_PORT: String(p), STORAGE_UNIT_ID: `shard-unit-${i}`, NODE_NAME: `node-${'abc'[i]}`, STORAGE_DATA_DIR: join(tmp, `u${i}`) }));
  const STORAGE_UNITS = ports.map((p) => `http://127.0.0.1:${p}`).join(',');
  const ring = new HttpStorageClient({ units: await discoverUnits({ STORAGE_UNITS }, 20), stateTtlMs: 0 });
  await ring.repair();
  run('npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), { STORAGE_UNITS, AGGREGATOR_PORT: '19420', INTERNAL_SERVICE_KEY: 'ik', AUDIT_TOKEN: 'audit-secret', STORAGE_STATE_TTL_MS: '200' });
  const H = { authorization: 'Bearer audit-secret' };
  await until(async () => (await fetch('http://127.0.0.1:19420/internal/audit/ring', { headers: H })).ok);
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const ref = `eq-${i}`;
    const e: StoredHazardEvent = { hazard_id: hazardId('BMKG', ref), source: 'BMKG', source_ref_id: ref, hazard_type: 'SEISMIC', severity: 'WASPADA', area_name: `area-${i % 9}`, latitude: -6, longitude: 106,
      occurred_at: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString(), ingested_at: new Date(Date.UTC(2026, 10, 22, 0, 0, i % 3600)).toISOString(), attributes: {}, version: 1 };
    await ring.upsertEvent(e, { fence: 1, fenceName: 'placement', idempotencyKey: `p-${i}`, correlationId: 'p' });
  }
  const pl = await (await fetch('http://127.0.0.1:19420/internal/audit/placement', { headers: H })).json() as any;
  line(`placement of ${pl.total_events} events, rf=${pl.rf}:`);
  line('  unit            node    primary  replica  held   share of all events');
  for (const u of pl.units) line(`  ${u.unit.padEnd(15)} ${u.node.padEnd(7)} ${String(u.primary_keys).padStart(7)}  ${String(u.replica_keys).padStart(7)}  ${String(u.keys_held).padStart(5)}  ${(u.shard_share * 100).toFixed(1)} %`);
  check('no unit holds the whole dataset (every unit share < 100 %)', pl.units.every((u: any) => u.shard_share < 1));
  check('primary (write load) is spread over more than one node', pl.units.filter((u: any) => u.primary_keys > 0).length > 1);
  // 64 virtual nodes per unit leave a natural skew; the report states it. Bound: no unit is primary for more than half of the data and none for less than a fifth.
  const pr = pl.units.map((u: any) => u.primary_keys / pl.total_events);
  line(`  primary share per unit: ${pr.map((x: number) => (x * 100).toFixed(1) + ' %').join(' / ')} (max/min ${(Math.max(...pr) / Math.min(...pr)).toFixed(2)})`);
  check('primary share per unit stays between 20 % and 50 % (natural consistent-hashing skew, no hot unit)', pr.every((x: number) => x > 0.2 && x < 0.5));
  check('every unit holds both primary and replica keys (a node keeps replicas of units whose primary is elsewhere)', pl.units.every((u: any) => u.primary_keys > 0 && u.replica_keys > 0));
  check('replica of every key sits on a node different from its primary (P1-K4 normal condition)', pl.replicas_on_distinct_nodes === true);
  check('primary + replica copies = rf x events', pl.units.reduce((s: number, u: any) => s + u.primary_keys + u.replica_keys, 0) === pl.rf * pl.total_events);
  const loc = await (await fetch(`http://127.0.0.1:19420/internal/audit/location?hazard_id=${hazardId('BMKG', 'eq-42')}`, { headers: H })).json() as any;
  line(`  location of eq-42: ${JSON.stringify(loc.locations)}`);
  check('/internal/audit/location reports primary and replica on two different nodes', loc.locations.length === 2 && loc.locations[0].role === 'primary' && loc.locations[1].role === 'replica' && loc.locations[0].node !== loc.locations[1].node);
  line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs) { try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ } } rmSync(tmp, { recursive: true, force: true }); });
