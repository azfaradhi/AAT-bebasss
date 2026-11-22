// P5-K2/K3/K4 on real processes for the behaviours the default fixture stream does not contain: B1 silent freeze (stale observed_at), B3 missing/null required fields,
// B8 transport faults (hang, 429, 500, truncated JSON, invalid bytes) while /healthz stays 200. Our own fixture, not the assistants' image.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';

const ROOT = join(__dirname, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'p5b-'));
const procs = new Map<string, ChildProcess>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const sig = (p: ChildProcess, s: NodeJS.Signals) => { try { process.kill(-p.pid!, s); } catch { /* gone */ } };
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };
const run = (name: string, cmd: string, args: string[], cwd: string, env: Record<string, string>) => procs.set(name, spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: process.env.DEMO_LOGS ? 'inherit' : 'ignore', detached: true }));
async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(150); }
}
const j = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers }).then((r) => r.json() as Promise<any>);
const post = (url: string) => fetch(url, { method: 'POST' }).then((r) => r.json() as Promise<any>);

async function main(): Promise<void> {
  const ports = [19940, 19941, 19942];
  ports.forEach((p, i) => run(`unit-${i}`, 'node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), { STORAGE_UNIT_PORT: String(p), STORAGE_UNIT_ID: `unit-${i}`, NODE_NAME: `node-${i}`, STORAGE_DATA_DIR: join(tmp, `u${i}`) }));
  const STORAGE_UNITS = ports.map((p) => `http://127.0.0.1:${p}`).join(',');
  const ring = new HttpStorageClient({ units: await discoverUnits({ STORAGE_UNITS }, 20), stateTtlMs: 0 });
  await ring.repair();
  const HOST = 'http://127.0.0.1:19950', SENSOR = 'http://127.0.0.1:19951', KUBE = 'http://127.0.0.1:19952';
  run('host', 'npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), { STORAGE_UNITS, AGGREGATOR_PORT: '19950', INTERNAL_SERVICE_KEY: 'ik', AUDIT_TOKEN: 'audit-secret', STORAGE_STATE_TTL_MS: '200' });
  run('kube', 'npx', ['tsx', 'scripts/fake-apiserver.ts'], join(ROOT, 'services/aggregator'), { KUBE_API_PORT: '19952', LEASE_NAMESPACE: 'bnpb' });
  run('sensor', 'node', ['tools/sensor-fixture-server/server.mjs'], ROOT, { PORT: '19951', SENSOR_TOKEN: 'st', TOTAL: '100', PAGE_SIZE: '20' });
  await until('stack up', async () => (await fetch(`${HOST}/health`)).ok && (await fetch(`${SENSOR}/healthz`)).ok);
  const expected = await j(`${SENSOR}/admin/expected`);
  run('poller', 'npx', ['tsx', 'scripts/poller-host.ts'], join(ROOT, 'services/aggregator'), {
    KUBE_API_URL: KUBE, LEASE_NAMESPACE: 'bnpb', LEASE_DURATION_SECONDS: '4', LEASE_RENEW_INTERVAL_MS: '500', STORAGE_UNITS, POD_NAME: 'poller-1', HOSTNAME: 'poller-1',
    BMKG_BASE_URL: 'http://127.0.0.1:1', BMKG_API_KEY: 'x', PVMBG_BASE_URL: 'http://127.0.0.1:1', PVMBG_ACCESS_TOKEN: 'x', POLL_INTERVAL_MS: '60000',
    PANTAI_BASE_URL: SENSOR, PANTAI_AUTH_TOKEN: 'st', PANTAI_POLL_INTERVAL_MS: '400', SOURCE_TIMEOUT_MS: '1500',
  });
  const coastal = async () => (await ring.listEvents({ source: 'SENSOR_PANTAI', limit: 1000 })).items;
  const parked = async () => ((await j(`${HOST}/internal/audit/unprocessed?limit=1000&source=SENSOR_PANTAI`, { authorization: 'Bearer audit-secret' })).items as any[]);
  const alive = () => procs.get('poller')!.exitCode === null;
  await until('baseline stream stored', async () => (await coastal()).length >= expected.valid.length, 90_000);
  await sleep(1500);
  const base = { stored: (await coastal()).length, parked: (await parked()).length };
  line(`baseline: ${base.stored} stored, ${base.parked} parked (default stream of ${expected.total}, ${expected.violations.length} violations)`);

  // B1 / B3: appended to the end of the stream; the poller must park them with a reason and store nothing.
  for (const kind of ['stale', 'missing', 'null']) await post(`${SENSOR}/admin/inject?kind=${kind}`);
  const after = await until('three injected items parked', async () => { const p = await parked(); return p.length >= base.parked + 3 ? p : null; }, 30_000);
  const extra = (await j(`${SENSOR}/admin/expected-extra`)).items as Array<{ kind: string; observation_id: string }>;
  const stored = await coastal();
  const reasons = after.map((x) => String(x.reason));
  line(`injected ${extra.map((e) => `${e.kind}=${e.observation_id}`).join(', ')}; parked reasons seen: ${[...new Set(reasons.map((r) => r.split(':')[0] + ':' + (r.split(':')[1] ?? '').trim().slice(0, 40)))].slice(0, 8).join(' | ')}`);
  check('B1/B3: stale, missing-field and null-field observations are parked with a reason (3 more parked)', after.length >= base.parked + 3);
  check('B1/B3: none of the three was stored as an event', extra.every((e) => !stored.some((s) => s.source_ref_id === e.observation_id)) && stored.length === base.stored);

  // B8: transport faults. /healthz must stay 200 (the sensor "looks healthy"); the poller must stay alive and keep the request rate bounded.
  const requests = async () => ((await j(`${SENSOR}/admin/request-log`)).data as any[]).filter((e) => e.path === '/v1/observations').length;
  for (const [mode, ms] of [['truncated', 3000], ['garbage', 3000], ['hang', 5000], ['429', 3000], ['500', 3000]] as const) {
    const r0 = await requests(), p0 = (await parked()).length;
    await post(`${SENSOR}/admin/transport?mode=${mode}&ms=${ms}`);
    const health = (await fetch(`${SENSOR}/healthz`)).status;
    await sleep(ms + 800);
    const r1 = await requests(), p1 = (await parked()).length;
    line(`  ${mode.padEnd(9)} ${ms} ms: healthz=${health}, calls to /v1/observations during the fault window: ${r1 - r0} (polls would be ${Math.round((ms + 800) / 400)}), poller alive=${alive()}, newly parked=${p1 - p0}`);
    check(`B8 ${mode}: /healthz stays 200, poller process survives`, health === 200 && alive());
    if (mode === 'truncated' || mode === 'garbage') check(`B8 ${mode}: the unreadable response is parked as a batch, not parsed, not stored`, p1 > p0);
  }
  // after the faults: still polling and validating
  await post(`${SENSOR}/admin/inject?kind=stale`);
  const total = (await parked()).length;
  await until('poller validates again after the faults', async () => (await parked()).length > total, 30_000).then(() => check('recovery: after all faults the poller polls again and still parks a new stale item', true)).catch(() => check('recovery: after all faults the poller polls again and still parks a new stale item', false));
  check('nothing was lost or duplicated: valid observations stored exactly once', (await coastal()).length === expected.valid.length && new Set((await coastal()).map((e) => e.source_ref_id)).size === expected.valid.length);
  line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs.values()) sig(p, 'SIGKILL'); rmSync(tmp, { recursive: true, force: true }); });
