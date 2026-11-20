// P1-K7 on real processes: ring + aggregator host + analytics-dashboard; dashboard numbers must equal the Audit API, and the page must flag incomplete data.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hazardId, dashboardCategory } from '../../shared-types/src/m2/ids';
import type { HazardEvent, HazardSource, HazardType, Severity } from '../../shared-types/src/m2/types';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';

const ROOT = join(__dirname, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'analytics-'));
const procs = new Map<string, ChildProcess>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
// DEMO_HOLD_MS keeps the stack up at two points so a browser screenshot can be taken (HOLD lines mark them).
const hold = async (label: string) => { if (Number(process.env.DEMO_HOLD_MS)) { line(`HOLD ${label}`); await sleep(Number(process.env.DEMO_HOLD_MS)); } };
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
    await sleep(250);
  }
}

const AREAS = ['Palu', 'Cianjur', 'Sleman', 'Pesisir Selatan', 'Aceh Barat'];
const MIX: Array<[HazardSource, HazardType, Severity, boolean]> = [
  ['BMKG', 'SEISMIC', 'WASPADA', false], ['BMKG', 'SEISMIC', 'AWAS', true], ['PVMBG', 'VOLCANIC', 'SIAGA', false],
  ['SATELIT', 'WILDFIRE', 'NORMAL', false], ['SENSOR_PANTAI', 'COASTAL', 'WASPADA', false],
];

async function main(): Promise<void> {
  const ports = [18210, 18211, 18212];
  const names = ['unit-a', 'unit-b', 'unit-c'];
  const startUnit = (i: number) => run(names[i], 'node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), { STORAGE_UNIT_PORT: String(ports[i]), STORAGE_UNIT_ID: names[i], NODE_NAME: names[i].replace('unit-', 'node-'), STORAGE_DATA_DIR: join(tmp, names[i]) });
  names.forEach((_, i) => startUnit(i));
  const STORAGE_UNITS = ports.map((p) => `http://127.0.0.1:${p}`).join(',');
  const units = await discoverUnits({ STORAGE_UNITS }, 20);
  const ring = new HttpStorageClient({ units, stateTtlMs: 0 });
  await ring.repair();

  const base = Date.UTC(2026, 10, 15);
  const ctx = (src: string) => ({ fence: 1, fenceName: src.toLowerCase(), idempotencyKey: 'seed', correlationId: 'seed' });
  const total = 600;
  // Deterministic, uneven mix so the type lines differ on the chart.
  let rnd = 12345;
  const next = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
  const WEIGHTS = [0.3, 0.1, 0.2, 0.25, 0.15];
  const pick = () => { let r = next(); for (let k = 0; k < WEIGHTS.length; k++) { r -= WEIGHTS[k]; if (r < 0) return k; } return 0; };
  for (let i = 0; i < total; i++) {
    const [source, hazard_type, severity, tsunami] = MIX[pick()];
    const ref = `seed-${i}`;
    const e: HazardEvent = {
      hazard_id: hazardId(source, ref), source, source_ref_id: ref, hazard_type, severity,
      occurred_at: new Date(base + Math.floor(i / 25) * 3_600_000 * 7).toISOString(),
      area_name: AREAS[Math.floor(next() * AREAS.length)], coordinates: { latitude: -6 - (i % 7) / 10, longitude: 106 + (i % 11) / 10 },
      description: `seed ${i}`, ...(tsunami ? { attributes: { potential_tsunami: true } } : {}),
    };
    await ring.upsertEvent(e, ctx(source));
  }
  line(`seeded ${total} events across 5 sources/types`);

  const AGG = 'http://127.0.0.1:18224', DASH = 'http://127.0.0.1:18225';
  run('aggregator-host', 'npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), { STORAGE_UNITS, AGGREGATOR_PORT: '18224', INTERNAL_SERVICE_KEY: 'ik', AUDIT_TOKEN: 'audit-secret', STORAGE_STATE_TTL_MS: '200' });
  run('dashboard', 'npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/analytics-dashboard'), { ANALYTICS_DASHBOARD_PORT: '18225', AGGREGATOR_BASE_URL: AGG, INTERNAL_SERVICE_KEY: 'ik' });
  await until('dashboard up', async () => (await fetch(`${DASH}/ready`)).ok);
  await until('aggregator up', async () => (await fetch(`${AGG}/internal/audit/ring`, { headers: { authorization: 'Bearer audit-secret' } })).ok);

  const page = await fetch(`${DASH}/`);
  check('GET / serves the dashboard page (HTML)', page.status === 200 && (await page.text()).includes('Analitik Kebencanaan'));

  // Independent expectation computed from the Audit API only (paged over every source).
  const audit = async (path: string) => (await fetch(`${AGG}${path}`, { headers: { authorization: 'Bearer audit-secret' } })).json() as Promise<any>;
  const all: HazardEvent[] = [];
  for (const source of ['BMKG', 'PVMBG', 'SATELIT', 'SENSOR_PANTAI']) {
    let cursor: string | undefined;
    do {
      const pg = await audit(`/internal/audit/events?source=${source}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      all.push(...pg.items); cursor = pg.next_cursor ?? undefined;
    } while (cursor);
  }
  const sev: Record<string, number> = { NORMAL: 0, WASPADA: 0, SIAGA: 0, AWAS: 0 };
  const area = new Map<string, number>();
  const day = new Map<string, Record<string, number>>();
  for (const e of all) {
    sev[e.severity]++; area.set(e.area_name, (area.get(e.area_name) ?? 0) + 1);
    const d = e.occurred_at.slice(0, 10) + 'T00:00:00.000Z';
    const row = day.get(d) ?? { gempa: 0, tsunami: 0, gunung_berapi: 0, kebakaran_hutan: 0, pesisir: 0 };
    row[dashboardCategory(e)]++; day.set(d, row);
  }
  const dash = await (await fetch(`${DASH}/api/summary?bucket=day`)).json() as any;
  check(`Audit lists ${all.length} events, equal to the seeded ${total}`, all.length === total);
  check('dashboard total = Audit event count', dash.total === all.length);
  check('dashboard per-severity = counts computed from Audit events', JSON.stringify(dash.by_severity) === JSON.stringify(sev));
  check('dashboard per-area = counts computed from Audit events', dash.by_area.length === area.size && dash.by_area.every((a: any) => area.get(a.area_name) === a.count));
  check('dashboard per-type-over-time = counts computed from Audit events', dash.by_type_over_time.length === day.size && dash.by_type_over_time.every((r: any) => { const w = day.get(r.bucket)!; return Object.keys(w).every((k) => w[k] === r[k]); }));
  check('complete ring: partial=false, no unavailable units', dash.partial === false && dash.unavailable_units.length === 0);

  await hold('complete');
  const from = new Date(base + 6 * 3_600_000).toISOString();
  const ranged = await (await fetch(`${DASH}/api/summary?bucket=hour&from=${encodeURIComponent(from)}`)).json() as any;
  check('from/bucket filters pass through (hourly buckets, fewer events than total)', ranged.total < dash.total && ranged.by_type_over_time.every((r: any) => r.bucket >= from));

  // One unit down: RF=2 keeps everything, still complete. Two of three down: some arc has no STABLE replica -> flagged.
  const kill = async (n: string) => { const p = procs.get(n)!; killGroup(p); await new Promise((r) => p.once('exit', r)); };
  await kill('unit-b');
  const one = await (await fetch(`${DASH}/api/summary?bucket=day`)).json() as any;
  check('one unit down: dashboard total unchanged and not partial', one.total === total && one.partial === false);
  await kill('unit-c');
  const two = await until('partial marker', async () => { const r = await (await fetch(`${DASH}/api/summary?bucket=day`)).json() as any; return r.partial ? r : null; }, 15_000);
  check(`two units down: dashboard flags partial=true and names ${two.unavailable_units.join(', ')}`, two.partial === true && two.unavailable_units.length >= 1);
  await hold('partial');
  await kill('aggregator-host');
  const gone = await fetch(`${DASH}/api/summary`);
  check('aggregator down: dashboard answers 503 in the error envelope (not 500)', gone.status === 503 && (await gone.json() as any).error?.code === 'SERVICE_UNAVAILABLE');

  line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs.values()) killGroup(p); rmSync(tmp, { recursive: true, force: true }); });
