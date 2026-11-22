// P5-K7 groundwork without Prometheus: runs real processes under traffic, scrapes their /metrics, and checks that every metric and label selector used by the Grafana dashboards
// and the SLO rules (deploy/k8s/observability) is really exposed. A panel whose metric or label never appears would show "No data" during a game day.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hazardId } from '../../shared-types/src/m2/ids';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';

const ROOT = join(__dirname, '../..');
const jwt = createRequire(join(ROOT, 'services/client-api/package.json'))('jsonwebtoken') as { sign: (p: object, s: string, o: object) => string };
const tmp = mkdtempSync(join(tmpdir(), 'obs-'));
const procs: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const run = (cmd: string, args: string[], cwd: string, env: Record<string, string>) => procs.push(spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore', detached: true }));
async function until(what: string, fn: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) { if (await fn().catch(() => false)) return; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(200); }
}

async function main(): Promise<void> {
  execFileSync('node', [join(ROOT, 'scripts/demo/obs-extract.mjs'), tmp]);
  const exprs = JSON.parse(readFileSync(join(tmp, 'exprs.json'), 'utf8')) as Array<{ dashboard: string; panel: string; expr: string }>;
  exprs.push(...readFileSync(join(tmp, 'slo_rules.yml'), 'utf8').split(/- record: /).slice(1).map((b) => ({ dashboard: 'SLO rules', panel: b.split('\n')[0].trim(), expr: b.split('expr: |')[1] ?? '' })));

  const ports = [19810, 19811, 19812];
  ports.forEach((p, i) => run('node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), { STORAGE_UNIT_PORT: String(p), STORAGE_UNIT_ID: `unit-${i}`, NODE_NAME: `node-${i}`, STORAGE_DATA_DIR: join(tmp, `u${i}`) }));
  const STORAGE_UNITS = ports.map((p) => `http://127.0.0.1:${p}`).join(',');
  const ring = new HttpStorageClient({ units: await discoverUnits({ STORAGE_UNITS }, 20), stateTtlMs: 0 });
  await ring.repair();
  for (let i = 0; i < 50; i++) {
    const ref = `o-${i}`;
    await ring.upsertEvent({ hazard_id: hazardId('BMKG', ref), source: 'BMKG', source_ref_id: ref, hazard_type: 'SEISMIC', severity: 'WASPADA', occurred_at: new Date(Date.UTC(2026, 10, 15, 0, 0, i)).toISOString(), area_name: 'A', coordinates: { latitude: -1, longitude: 100 }, description: 'obs audit' }, { fence: 1, fenceName: 'seed', idempotencyKey: `o-${i}`, correlationId: 'o' });
  }
  const AGG = 'http://127.0.0.1:19820', API = 'http://127.0.0.1:19821';
  run('npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), { STORAGE_UNITS, AGGREGATOR_PORT: '19820', INTERNAL_SERVICE_KEY: 'ik', AUDIT_TOKEN: 'audit-secret', STORAGE_STATE_TTL_MS: '200' });
  run('node', ['dist/services/client-api/src/index.js'], join(ROOT, 'services/client-api'), { CLIENT_API_PORT: '19821', CLIENT_JWT_SECRET: 'js', INTERNAL_SERVICE_KEY: 'ik', AGGREGATOR_BASE_URL: AGG, ADMISSION_MAX_INFLIGHT: '4', ADMISSION_LAPANGAN_RESERVED: '2', ADMISSION_MEDIA_MAX_INFLIGHT: '1', ADMISSION_RETRY_AFTER_S: '3' });
  // The real aggregator (pollers, outbox dispatcher, breaker) with an unreachable broker, plus the satellite processor over the feed fixture: these are the sources of the P3/P4/P5 metrics.
  const KUBE = 'http://127.0.0.1:19830', SENSOR = 'http://127.0.0.1:19831', BM = 'http://127.0.0.1:19832', PV = 'http://127.0.0.1:19833', FEED = 'http://127.0.0.1:19834', AGG2 = 'http://127.0.0.1:19835', SAT = 'http://127.0.0.1:19836';
  run('npx', ['tsx', 'scripts/fake-apiserver.ts'], join(ROOT, 'services/aggregator'), { KUBE_API_PORT: '19830', LEASE_NAMESPACE: 'bnpb' });
  run('node', ['tools/sensor-fixture-server/server.mjs'], ROOT, { PORT: '19831', SENSOR_TOKEN: 'st', TOTAL: '300', PAGE_SIZE: '20' });
  run('node', ['dist/services/bmkg-mock/src/index.js'], join(ROOT, 'services/bmkg-mock'), { BMKG_PORT: '19832', BMKG_API_KEY: 'bk', BMKG_DELAY_MIN_MS: '5', BMKG_DELAY_MAX_MS: '20' });
  run('node', ['dist/services/pvmbg-mock/src/index.js'], join(ROOT, 'services/pvmbg-mock'), { PVMBG_PORT: '19833', PVMBG_JWT_SECRET: 'ps', PVMBG_DELAY_MIN_MS: '5', PVMBG_DELAY_MAX_MS: '20' });
  run('node', ['tools/feed-fixture-server/server.mjs'], ROOT, { PORT: '19834', FIXTURE_TOKEN: 'tok', FRAMES_PER_SECOND: '1500' });
  await until('stack up', async () => (await fetch(`${AGG}/health`)).ok && (await fetch(`${API}/health`)).ok && (await fetch(`${SENSOR}/healthz`)).ok && (await fetch(`${BM}/health`)).ok && (await fetch(`${PV}/health`)).ok);
  const pvToken = jwt.sign({ sub: 'aggregator' }, 'ps', { audience: 'pvmbg', expiresIn: '2h' });
  run('npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/aggregator'), {
    AGGREGATOR_PORT: '19835', STORAGE_UNITS, KUBE_API_URL: KUBE, LEASE_NAMESPACE: 'bnpb', LEASE_DURATION_SECONDS: '4', LEASE_RENEW_INTERVAL_MS: '500', POD_NAME: 'agg-obs', HOSTNAME: 'agg-obs',
    RABBITMQ_URL: 'amqp://x:y@127.0.0.1:1', INTERNAL_SERVICE_KEY: 'ik', AUDIT_TOKEN: 'audit-secret', BMKG_BASE_URL: BM, BMKG_API_KEY: 'bk', PVMBG_BASE_URL: PV, PVMBG_ACCESS_TOKEN: pvToken,
    POLL_INTERVAL_MS: '1000', PANTAI_BASE_URL: SENSOR, PANTAI_AUTH_TOKEN: 'st', PANTAI_POLL_INTERVAL_MS: '300',
  });
  run('npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/satellite-processor'), {
    STORAGE_GATEWAY_URL: AGG, INTERNAL_SERVICE_KEY: 'ik', KUBE_API_URL: KUBE, LEASE_NAMESPACE: 'bnpb', LEASE_DURATION_SECONDS: '4', LEASE_RENEW_INTERVAL_MS: '500',
    SAT_FEED_BASE_URL: FEED, SAT_GROUP_TOKEN: 'tok', SATELLITE_PORT: '19836', POD_NAME: 'sat-obs', SAT_RECONNECT_MIN_MS: '100',
  });
  await sleep(1000);
  await fetch(`${SENSOR}/admin/outage?ms=3000`, { method: 'POST' });
  await sleep(12_000);
  const tok = (scope: string) => jwt.sign({ sub: scope, scope, aud: 'bnpb-client', purpose: 'access' }, 'js', { expiresIn: '10m', algorithm: 'HS256' });
  await Promise.all(Array.from({ length: 60 }, async (_, i) => { for (let k = 0; k < 20; k++) await fetch(`${API}/api/v1/hazards?limit=20`, { headers: { authorization: `Bearer ${tok(i % 6 === 0 ? 'lapangan' : 'media')}` } }).then((r) => r.arrayBuffer()); }));
  await fetch(`${API}/api/v1/hazards`, { headers: { authorization: 'Bearer bad' } });
  await sleep(500);

  const targets: Array<[string, string]> = [['client-api', `${API}/metrics`], ['aggregator ring-host', `${AGG}/metrics`], ['aggregator (real index.ts)', `${AGG2}/metrics`], ['satellite-processor', `${SAT}/metrics`], ...ports.map((p, i) => [`storage-unit-${i}`, `http://127.0.0.1:${p}/metrics`] as [string, string])];
  const samples: Array<{ name: string; labels: Record<string, string>; from: string }> = [];
  for (const [from, url] of targets) {
    const text = await fetch(url).then((r) => r.text()).catch(() => '');
    line(`scraped ${from}: ${text ? text.split('\n').filter((l) => l && !l.startsWith('#')).length : 0} samples`);
    for (const l of text.split('\n')) {
      const m = l.match(/^([a-zA-Z_:][\w:]*)(?:\{([^}]*)\})? /);
      if (!m) continue;
      const labels: Record<string, string> = {};
      for (const kv of (m[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[kv[1]] = kv[2];
      samples.push({ name: m[1], labels, from });
    }
  }
  const base = (n: string) => n.replace(/_(bucket|count|sum)$/, '');
  let bad = 0;
  const rows: string[] = [];
  for (const e of exprs) {
    const sels = [...e.expr.matchAll(/\b(bnpb_[a-z0-9_]+)(?:\{([^}]*)\})?/g)];
    const results: string[] = [];
    for (const s of sels) {
      const want: Record<string, string> = {};
      for (const kv of (s[2] ?? '').matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) want[kv[1]] = kv[2];
      const named = samples.filter((x) => x.name === s[1] || base(x.name) === base(s[1]));
      const full = named.filter((x) => Object.entries(want).every(([k, v]) => x.labels[k] === v));
      const status = full.length ? 'ok' : named.length ? `labels ${JSON.stringify(want)} never seen (have: ${[...new Set(named.flatMap((x) => Object.keys(x.labels)))].join(',') || 'none'})` : 'metric not exposed by any scraped process';
      if (!full.length) { bad++; results.push(`${s[1]}: ${status}`); }
    }
    rows.push(`${results.length ? 'NO DATA' : 'ok     '} [${e.dashboard}] ${e.panel}${results.length ? '\n          ' + results.join('\n          ') : ''}`);
  }
  line(`checked ${exprs.length} dashboard/rule expressions against ${samples.length} scraped samples (client-api, ring-host, real aggregator with an unreachable broker and pollers, satellite-processor, 3 storage units; no notifier and no broker, so critical-alert metrics cannot appear)`);
  rows.forEach(line);
  line(`RESULT: ${bad === 0 ? 'every selector found' : `${bad} selector(s) without data in this run`}`);
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs) { try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ } } rmSync(tmp, { recursive: true, force: true }); });
