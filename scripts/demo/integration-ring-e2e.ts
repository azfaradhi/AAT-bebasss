// Integration demo on real processes: satellite feed + field reports flow into one shared ring, survive a unit kill, and read back.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FieldReportStore } from '../../shared-types/src/field-reports';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';
import { discoverUnits } from '../../shared-types/src/ring/factory';

const ROOT = join(__dirname, '../..');
const requireFromApi = createRequire(join(ROOT, 'services/client-api/package.json'));
const jwt = requireFromApi('jsonwebtoken') as { sign: (p: object, s: string, o: object) => string };
const tmp = mkdtempSync(join(tmpdir(), 'e2e-'));
const procs = new Map<string, ChildProcess>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };

function killGroup(p: ChildProcess): void {
  try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* already gone */ }
}
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

async function main(): Promise<void> {
  const unitPorts = [18110, 18111, 18112];
  const names = ['unit-a', 'unit-b', 'unit-c'];
  const startUnit = (i: number, fresh: boolean) => {
    if (fresh) rmSync(join(tmp, names[i]), { recursive: true, force: true });
    run(names[i], 'node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), {
      STORAGE_UNIT_PORT: String(unitPorts[i]), STORAGE_UNIT_ID: names[i], NODE_NAME: names[i].replace('unit-', 'node-'), STORAGE_DATA_DIR: join(tmp, names[i]),
    });
  };
  names.forEach((_, i) => startUnit(i, true));
  const STORAGE_UNITS = unitPorts.map((p) => `http://127.0.0.1:${p}`).join(',');
  const units = await discoverUnits({ STORAGE_UNITS }, 20);
  const ring = new HttpStorageClient({ units, stateTtlMs: 0 });
  await ring.repair();
  line(`ring up: ${units.map((u) => `${u.unit}@${u.node}`).join(', ')}`);

  run('aggregator-host', 'npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), { STORAGE_UNITS, AGGREGATOR_PORT: '18124', INTERNAL_SERVICE_KEY: 'ik', AUDIT_TOKEN: 'audit-secret', STORAGE_STATE_TTL_MS: '200' });
  run('feed', 'node', ['tools/feed-fixture-server/server.mjs'], ROOT, { PORT: '18120', FIXTURE_TOKEN: 'tok', FRAMES_PER_SECOND: '800' });
  await sleep(500);
  // Components other than the Aggregator reach the ring only through its gateway (the store NetworkPolicy allows nothing else).
  const common = { STORAGE_GATEWAY_URL: 'http://127.0.0.1:18124', INTERNAL_SERVICE_KEY: 'ik' };
  run('satellite', 'npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/satellite-processor'), { ...common, SAT_FEED_BASE_URL: 'http://127.0.0.1:18120', SAT_GROUP_TOKEN: 'tok', SATELLITE_PORT: '18121' });
  run('field-processor', 'npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/field-report-processor'), { ...common, FIELD_REPORT_PORT: '18122' });
  run('client-api', 'npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/client-api'), { ...common, CLIENT_API_PORT: '18123', CLIENT_JWT_SECRET: 'demo-secret', INTERNAL_SERVICE_KEY: 'ik' });

  await until('aggregator host up', async () => (await fetch('http://127.0.0.1:18124/internal/storage/ringStatus', { method: 'POST', headers: { 'x-internal-key': 'ik', 'content-type': 'application/json' }, body: '{}' })).ok);
  await until('client-api up', async () => (await fetch('http://127.0.0.1:18123/health')).ok);
  const token = jwt.sign({ scope: 'lapangan', purpose: 'access' }, 'demo-secret', { subject: 'tim-lapangan-1', audience: 'bnpb-client', expiresIn: '5m', algorithm: 'HS256' });
  const report = { category: 'KERUSAKAN', description: 'Air naik 80 cm', latitude: -6.2, longitude: 106.8, observed_at: new Date().toISOString() };
  const post = (key: string) => fetch('http://127.0.0.1:18123/field-reports', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(report) });
  const first = await post('k-1');
  const firstBody = await first.json() as { report_id?: string };
  const again = await post('k-1');
  const againBody = await again.json() as { report_id?: string };
  check('POST /field-reports answers 202 (written to the ring before the reply)', first.status === 202 && typeof firstBody.report_id === 'string');
  check('the same Idempotency-Key is not stored twice', typeof firstBody.report_id === 'string' && againBody.report_id === firstBody.report_id);

  const store = new FieldReportStore(ring);
  const auditApi = (path: string) => fetch(`http://127.0.0.1:18124${path}`, { headers: { authorization: 'Bearer audit-secret' } }).then((r) => r.json() as Promise<any>);
  await until('field report processed', async () => (await store.audit({ limit: 100 })).processed_total >= 1).catch(async (e) => {
    line(`diagnostics: audit=${JSON.stringify(await store.audit({ limit: 100 }))}`);
    line(`pending markers: ${JSON.stringify((await ring.listDocs('field_reports', { prefix: 'p:', limit: 10 })).items)}`);
    line(`processor metrics: ${(await fetch('http://127.0.0.1:18122/metrics').then((r) => r.text()).catch((x) => String(x))).split('\n').filter((l) => l.startsWith('bnpb_field')).join(' | ')}`);
    throw e;
  });
  check('field-report-processor (another process) processed it from the shared ring', true);

  const sat = await until('satellite events in the ring', async () => {
    const p = await ring.listEvents({ source: 'SATELIT', limit: 1000 });
    return p.items.length > 0 ? p.items.length : false;
  }, 90_000);
  await sleep(4000);
  const before = await ring.checksum('SATELIT');
  line(`  satellite events in ring so far: ${before.count} (first sighting ${sat})`);
  check('satellite-processor wrote HazardEvents that another client reads from the ring', before.count > 0);
  const auditChecksum = await auditApi('/internal/audit/checksum?source=SATELIT');
  check('Audit API /internal/audit/checksum agrees with the ring (count and sha256)', auditChecksum.checksum === before.checksum && auditChecksum.count === before.count);
  const auditEvents = await auditApi('/internal/audit/events?source=SATELIT&limit=100');
  check('Audit API /internal/audit/events lists the satellite events', Array.isArray(auditEvents.items) && auditEvents.items.length > 0);
  const where = await auditApi(`/internal/audit/location?hazard_id=${auditEvents.items[0].hazard_id}`);
  check('Audit API /internal/audit/location names two distinct nodes (primary + replica)', where.locations?.length === 2 && new Set(where.locations.map((l: { node: string }) => l.node)).size === 2);

  const killed = procs.get('unit-b')!;
  killGroup(killed);
  await new Promise((r) => killed.once('exit', r));
  const after = await ring.checksum('SATELIT');
  const audit = await store.audit({ limit: 100 });
  check('one storage unit killed: satellite events still complete (same count, partial=false)', after.count >= before.count && !after.partial);
  check('one storage unit killed: field report still visible', audit.accepted_total >= 1);
  const second = await post('k-2');
  check('one storage unit killed: new reports are still accepted (202)', second.status === 202);

  startUnit(1, true);
  await sleep(500);
  const repaired = await until('repair', async () => { const r = await ring.repair(); return r.repaired.length ? r : null; }, 20_000);
  check(`wiped unit rejoined through repair (${repaired.repaired.join(',')}) and redundancy is restored`, (await ring.ringStatus()).redundancy_ok);
  const final = await ring.checksum('SATELIT');
  check('final ring is complete and not partial', !final.partial && final.count >= before.count);
  line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}

main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs.values()) killGroup(p); rmSync(tmp, { recursive: true, force: true }); });
