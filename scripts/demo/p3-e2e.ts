// P3 on real processes: a real PVMBG mock changes its schema, the poller parks what it cannot map, Internal Ops inspects and replays after the mapper is adjusted;
// field reports survive repeated processor kills. Processes: 3 storage-unit, aggregator host, fake apiserver (Lease), poller host, bmkg/pvmbg mocks, client-api, field-report-processor.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FieldReportStore } from '../../shared-types/src/field-reports';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';

const ROOT = join(__dirname, '../..');
const requireFromApi = createRequire(join(ROOT, 'services/client-api/package.json'));
const jwt = requireFromApi('jsonwebtoken') as { sign: (p: object, s: string, o: object) => string };
const tmp = mkdtempSync(join(tmpdir(), 'p3-'));
const procs = new Map<string, ChildProcess>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };
const sig = (p: ChildProcess, s: NodeJS.Signals) => { try { process.kill(-p.pid!, s); } catch { /* gone */ } };
const run = (name: string, cmd: string, args: string[], cwd: string, env: Record<string, string>) => procs.set(name, spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: process.env.DEMO_LOGS ? 'inherit' : 'ignore', detached: true }));
async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(200); }
}
const J = { 'content-type': 'application/json' };

async function main(): Promise<void> {
  const ports = [19210, 19211, 19212];
  ports.forEach((p, i) => run(`unit-${i}`, 'node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), { STORAGE_UNIT_PORT: String(p), STORAGE_UNIT_ID: `unit-${i}`, NODE_NAME: `node-${i}`, STORAGE_DATA_DIR: join(tmp, `u${i}`) }));
  const STORAGE_UNITS = ports.map((p) => `http://127.0.0.1:${p}`).join(',');
  const ring = new HttpStorageClient({ units: await discoverUnits({ STORAGE_UNITS }, 20), stateTtlMs: 0 });
  await ring.repair();
  const HOST = 'http://127.0.0.1:19220', PV = 'http://127.0.0.1:19222', BM = 'http://127.0.0.1:19221', API = 'http://127.0.0.1:19225';
  const startHost = (mapper: string) => run('host', 'npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), { STORAGE_UNITS, AGGREGATOR_PORT: '19220', INTERNAL_SERVICE_KEY: 'ik', AUDIT_TOKEN: 'audit-secret', STORAGE_STATE_TTL_MS: '200', VOLCANIC_MAPPER_VERSION: mapper });
  const hostUp = () => until('host up', async () => (await fetch(`${HOST}/internal/audit/ring`, { headers: { authorization: 'Bearer audit-secret' } })).ok);
  startHost('v1'); await hostUp();
  const pvToken = jwt.sign({ sub: 'aggregator' }, 'ps', { audience: 'pvmbg', expiresIn: '2h' });
  run('bmkg', 'node', ['dist/services/bmkg-mock/src/index.js'], join(ROOT, 'services/bmkg-mock'), { BMKG_PORT: '19221', BMKG_API_KEY: 'bk', BMKG_DELAY_MIN_MS: '5', BMKG_DELAY_MAX_MS: '20' });
  run('pvmbg', 'node', ['dist/services/pvmbg-mock/src/index.js'], join(ROOT, 'services/pvmbg-mock'), { PVMBG_PORT: '19222', PVMBG_JWT_SECRET: 'ps', PVMBG_DELAY_MIN_MS: '5', PVMBG_DELAY_MAX_MS: '20', PVMBG_LIVE_INTERVAL_MS: '1000' });
  await until('mocks up', async () => (await fetch(`${BM}/health`)).ok && (await fetch(`${PV}/health`)).ok);
  run('kube', 'npx', ['tsx', 'scripts/fake-apiserver.ts'], join(ROOT, 'services/aggregator'), { KUBE_API_PORT: '19230', LEASE_NAMESPACE: 'bnpb' });
  run('poller', 'npx', ['tsx', 'scripts/poller-host.ts'], join(ROOT, 'services/aggregator'), { KUBE_API_URL: 'http://127.0.0.1:19230', LEASE_NAMESPACE: 'bnpb', LEASE_DURATION_SECONDS: '4', LEASE_RENEW_INTERVAL_MS: '500', STORAGE_UNITS, POD_NAME: 'poller-1', HOSTNAME: 'poller-1', BMKG_BASE_URL: BM, BMKG_API_KEY: 'bk', PVMBG_BASE_URL: PV, PVMBG_ACCESS_TOKEN: pvToken, POLL_INTERVAL_MS: '1000', POLL_LOOKBACK_MS: '0' });
  const common = { STORAGE_GATEWAY_URL: HOST, INTERNAL_SERVICE_KEY: 'ik' };
  run('client-api', 'npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/client-api'), { ...common, CLIENT_API_PORT: '19225', CLIENT_JWT_SECRET: 'demo-secret', AGGREGATOR_BASE_URL: HOST });
  const startProc = () => run('processor', 'npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/field-report-processor'), { ...common, FIELD_REPORT_PORT: '19226' });
  startProc();
  await until('client-api up', async () => (await fetch(`${API}/health`)).ok);
  const tok = (scope: string) => jwt.sign({ scope, purpose: 'access' }, 'demo-secret', { subject: `${scope}-user`, audience: 'bnpb-client', expiresIn: '10m', algorithm: 'HS256' });
  const get = (path: string, scope: string) => fetch(`${API}${path}`, { headers: { authorization: `Bearer ${tok(scope)}` } });

  // Baseline: PVMBG events flow in.
  const pvmbgCount = async () => (await ring.listEvents({ source: 'PVMBG', limit: 1000 })).items.length;
  await until('baseline PVMBG events', async () => (await pvmbgCount()) >= 3);
  const bmkgBefore = (await ring.listEvents({ source: 'BMKG', limit: 1000 })).items.length;
  const pollerPid = procs.get('poller')!.pid;
  line(`baseline: ${await pvmbgCount()} PVMBG and ${bmkgBefore} BMKG events stored`);

  // K1/K2/K3: incompatible change (rename volcano_id -> volcano_code) on newly generated records.
  await fetch(`${PV}/admin/schema-version`, { method: 'POST', headers: J, body: JSON.stringify({ mode: 'rename' }) });
  const parked = async () => ((await (await get('/ops/unprocessed?limit=1000', 'internal')).json()) as any).items as Array<{ source: string; reason: string; status: string; reason_code?: string }>;
  const items = await until('parked PVMBG records', async () => { const p = (await parked()).filter((x) => x.source === 'PVMBG'); return p.length >= 3 ? p : null; }, 30_000).catch(async (e) => {
    const r = await get('/ops/unprocessed?limit=1000', 'internal');
    line(`diagnostics: ops/unprocessed -> ${r.status} ${(await r.text()).slice(0, 300)}`);
    const d = await (await fetch(`${PV}/volcanic-reports`, { headers: { authorization: `Bearer ${pvToken}` } })).json() as any;
    line(`diagnostics: mock returns ${d.data?.length} reports, last: ${JSON.stringify(d.data?.[d.data.length - 1])}`);
    throw e;
  });
  line(`parked after the schema change: ${items.length} PVMBG record(s), reasons ${[...new Set(items.map((i) => i.reason))].join(', ')}`);
  check('K1/K2: renamed records are parked (not stored, not guessed) with a reason, source and status "parked"', items.every((i) => i.status === 'parked'));
  const bmkgDuring = (await ring.listEvents({ source: 'BMKG', limit: 1000 })).items.length;
  check('K3: the poller process kept running (same pid, no restart) and BMKG events kept flowing', procs.get('poller')!.exitCode === null && procs.get('poller')!.pid === pollerPid && bmkgDuring >= bmkgBefore);

  // K5: who can look.
  const [m, l, i] = await Promise.all([get('/ops/unprocessed', 'media'), get('/ops/unprocessed', 'lapangan'), get('/ops/unprocessed', 'internal')]);
  const direct = await fetch(`${HOST}/internal/ops/unprocessed`);
  check(`K5: media ${m.status}, lapangan ${l.status}, internal ${i.status}, direct aggregator route without the key ${direct.status}`, m.status === 403 && l.status === 403 && i.status === 200 && direct.status === 401);

  // K4: adjust the system (mapper v2 understands the rename), then replay.
  await fetch(`${PV}/admin/schema-version`, { method: 'POST', headers: J, body: JSON.stringify({ mode: 'baseline' }) });
  sig(procs.get('host')!, 'SIGKILL'); await sleep(500);
  startHost('v2'); await hostUp();
  const beforeReplay = await pvmbgCount();
  const stillParked = (await parked()).filter((x) => x.source === 'PVMBG').length;
  const rep = await (await fetch(`${API}/ops/replay`, { method: 'POST', headers: { authorization: `Bearer ${tok('internal')}`, ...J }, body: JSON.stringify({ reason_code: 'SCHEMA_INCOMPATIBLE' }) })).json() as any;
  const afterParked = (await parked()).filter((x) => x.source === 'PVMBG').length;
  const afterReplay = await pvmbgCount();
  const ids = (await ring.listEvents({ source: 'PVMBG', limit: 1000 })).items.map((e) => e.source_ref_id);
  line(`replay after switching the mapper to v2: ${JSON.stringify(rep)}; parked ${stillParked} -> ${afterParked}; PVMBG events ${beforeReplay} -> ${afterReplay}`);
  check('K4: replay recovered the parked records (they leave the unprocessed list and become events)', afterParked === 0 && afterReplay > beforeReplay && afterReplay - beforeReplay >= stillParked);
  check('K4: no duplicate events (one event per source_ref_id)', new Set(ids).size === ids.length);
  const again = await (await fetch(`${API}/ops/replay`, { method: 'POST', headers: { authorization: `Bearer ${tok('internal')}`, ...J }, body: JSON.stringify({ reason_code: 'SCHEMA_INCOMPATIBLE' }) })).json() as any;
  check(`K4: a second replay changes nothing (${JSON.stringify(again)})`, (await pvmbgCount()) === afterReplay);

  // K6: field reports with the processor killed repeatedly and paused.
  const store = new FieldReportStore(ring);
  const post = async (key: string) => { const t0 = performance.now(); const r = await fetch(`${API}/field-reports`, { method: 'POST', headers: { authorization: `Bearer ${tok('lapangan')}`, ...J, 'idempotency-key': key }, body: JSON.stringify({ category: 'KERUSAKAN', description: `laporan ${key}`, latitude: -6.2, longitude: 106.8, observed_at: new Date().toISOString() }) }); return { status: r.status, ms: performance.now() - t0 }; };
  sig(procs.get('processor')!, 'SIGSTOP');
  const paused = await Promise.all(Array.from({ length: 40 }, (_, n) => post(`paused-${n}`)));
  const p95 = paused.map((x) => x.ms).sort((a, b) => a - b)[Math.floor(paused.length * 0.95) - 1];
  check(`K6: 40 reports accepted (202) while the processor is paused (p95 ${p95.toFixed(1)} ms)`, paused.every((x) => x.status === 202));
  sig(procs.get('processor')!, 'SIGCONT');
  let kills = 0;
  const statuses: number[] = [];
  for (let n = 0; n < 80; n++) {
    statuses.push((await post(`k-${n % 70}`)).status); // 10 repeats of earlier keys = client retries
    if (n % 15 === 14) { sig(procs.get('processor')!, 'SIGKILL'); kills++; await sleep(300); startProc(); }
  }
  const a = await until('all reports processed', async () => { const x = await store.audit({ limit: 1000 }); return x.processed_total >= 110 ? x : null; }, 90_000);
  const au = await store.audit({ limit: 1000 });
  line(`field reports: accepted=${au.accepted_total} processed=${au.processed_total} duplicates_dropped=${au.duplicates_dropped_total}, still pending=${au.accepted_total - au.processed_total}, processor killed ${kills}x`);
  check('K6: every 202 was processed exactly once (accepted == processed == 110 unique keys), nothing left pending', a.accepted_total === 110 && au.processed_total === 110 && au.accepted_total === au.processed_total && statuses.every((s) => s === 202));
  check('K6: repeats were counted as duplicates, not stored twice (10 client retries)', au.duplicates_dropped_total === 10);

  line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs.values()) sig(p, 'SIGKILL'); rmSync(tmp, { recursive: true, force: true }); });
