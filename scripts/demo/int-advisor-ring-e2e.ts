// INT-4.4 on real processes: the advisor reads fires from the real ring through the gateway, flags the anomalous one, keeps advisories apart from events, and survives a unit loss.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hazardId } from '../../shared-types/src/m2/ids';
import type { StoredHazardEvent } from '../../shared-types/src/m2/types';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';

const ROOT = join(__dirname, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'adv-'));
const procs = new Map<string, ChildProcess>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };
const killGroup = (p: ChildProcess) => { try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ } };
const run = (name: string, cmd: string, args: string[], cwd: string, env: Record<string, string>) => procs.set(name, spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: process.env.DEMO_LOGS ? 'inherit' : 'ignore', detached: true }));
async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 45_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(200); }
}

async function main(): Promise<void> {
  const ports = [18960, 18961, 18962];
  ports.forEach((p, i) => run(`unit-${i}`, 'node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), { STORAGE_UNIT_PORT: String(p), STORAGE_UNIT_ID: `unit-${i}`, NODE_NAME: `node-${i}`, STORAGE_DATA_DIR: join(tmp, `u${i}`) }));
  const STORAGE_UNITS = ports.map((p) => `http://127.0.0.1:${p}`).join(',');
  const ring = new HttpStorageClient({ units: await discoverUnits({ STORAGE_UNITS }, 20), stateTtlMs: 0 });
  await ring.repair();
  run('host', 'npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), { STORAGE_UNITS, AGGREGATOR_PORT: '18970', INTERNAL_SERVICE_KEY: 'ik', STORAGE_STATE_TTL_MS: '200' });
  await until('host up', async () => (await fetch('http://127.0.0.1:18970/internal/storage/ringStatus', { method: 'POST', headers: { 'x-internal-key': 'ik', 'content-type': 'application/json' }, body: '{}' })).ok);
  // No LLM key: template-only mode, so nothing leaves the machine.
  run('advisor', 'npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/advisor'), { STORAGE_GATEWAY_URL: 'http://127.0.0.1:18970', INTERNAL_SERVICE_KEY: 'ik', ADVISOR_PORT: '18971', ADVISOR_POLL_MS: '500', ADVISOR_LLM_API_KEY: '', GROQ_API_KEY: '' });
  const adv = (path: string) => fetch(`http://127.0.0.1:18971${path}`, { headers: { 'x-internal-key': 'ik' } });
  await until('advisor ready', async () => (await fetch('http://127.0.0.1:18971/ready')).ok);

  const put = async (id: string, count: number) => {
    const e: StoredHazardEvent = {
      hazard_id: hazardId('SATELIT', id), source: 'SATELIT', source_ref_id: id, hazard_type: 'WILDFIRE', severity: 'WASPADA', area_name: 'Riau',
      latitude: 0, longitude: 100, occurred_at: '2026-11-16T05:30:00.000Z', ingested_at: '2026-11-16T05:31:00.000Z', attributes: { detection_count: count, satellites: ['N'], total_frp_mw: 20 }, version: count,
    };
    await ring.upsertEvent(e, { fence: 1, fenceName: 'satellite', idempotencyKey: `${id}-${count}`, correlationId: 'seed' });
    return e.hazard_id;
  };
  for (let i = 0; i < 8; i++) await put(`q${i}`, 4 + (i % 2));
  await sleep(1500);
  const hot = await put('hot', 4);
  await sleep(1500);
  const before = await ring.checksum('SATELIT');
  await put('hot', 16);

  const advisories = await until('advisory for the hot fire', async () => {
    const body = await (await adv('/internal/advisory?limit=50')).json() as any;
    return (body.items ?? []).some((i: any) => i.hazard_id === hot || JSON.stringify(i).includes(hot)) ? body : null;
  });
  line(`advisory served: label="${advisories.label}", llm_enabled=${advisories.llm_enabled}, ${advisories.items.length} item(s)`);
  const mine = advisories.items.filter((i: any) => JSON.stringify(i).includes(hot));
  check('advisor, reading the real ring through the gateway, flagged the one fire that grew (and only it)', mine.length >= 1 && advisories.items.every((i: any) => JSON.stringify(i).includes(hot)));
  check('advisory carries the "not an official assessment" label and runs template-only without a key', /ADVISORY/.test(advisories.label) && advisories.llm_enabled === false);
  const after = await ring.checksum('SATELIT');
  const listed = (await ring.listEvents({ source: 'SATELIT', limit: 100 })).items.length;
  check('advisories do not appear among events and do not change them (9 events listed, same count in the checksum before and after the advisory)', listed === 9 && after.count === before.count);

  const unit = procs.get('unit-1')!; killGroup(unit); await new Promise((r) => unit.once('exit', r));
  await sleep(2500);
  const ready = await fetch('http://127.0.0.1:18971/ready');
  const still = await (await adv('/internal/advisory?limit=50')).json() as any;
  check('one storage unit killed: advisor stays up and keeps serving its advisories', ready.ok && still.items.length >= 1);

  line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs.values()) killGroup(p); rmSync(tmp, { recursive: true, force: true }); });
