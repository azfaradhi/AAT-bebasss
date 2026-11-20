// P1-K3 and X-09 on real processes: a paginated Audit walk over events of every source equals the sorted ground truth, "latest 50" through client-api is newest-first,
// and JWT acceptance under wall-clock shifts of the client-api process follows the declared 60 s tolerance.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hazardId } from '../../shared-types/src/m2/ids';
import type { HazardSource, HazardType, StoredHazardEvent } from '../../shared-types/src/m2/types';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';

const ROOT = join(__dirname, '../..');
const jwt = createRequire(join(ROOT, 'services/client-api/package.json'))('jsonwebtoken') as { sign: (p: object, s: string, o: object) => string };
const tmp = mkdtempSync(join(tmpdir(), 'k3-'));
const procs: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };
const run = (cmd: string, args: string[], cwd: string, env: Record<string, string>) => { const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: process.env.DEMO_LOGS ? 'inherit' : 'ignore', detached: true }); procs.push(p); return p; };
async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(200); }
}

async function main(): Promise<void> {
  const ports = [19610, 19611, 19612];
  ports.forEach((p, i) => run('node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), { STORAGE_UNIT_PORT: String(p), STORAGE_UNIT_ID: `unit-${i}`, NODE_NAME: `node-${i}`, STORAGE_DATA_DIR: join(tmp, `u${i}`) }));
  const STORAGE_UNITS = ports.map((p) => `http://127.0.0.1:${p}`).join(',');
  const ring = new HttpStorageClient({ units: await discoverUnits({ STORAGE_UNITS }, 20), stateTtlMs: 0 });
  await ring.repair();
  const HOST = 'http://127.0.0.1:19620', API = 'http://127.0.0.1:19621';
  run('npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), { STORAGE_UNITS, AGGREGATOR_PORT: '19620', INTERNAL_SERVICE_KEY: 'ik', AUDIT_TOKEN: 'audit-secret', STORAGE_STATE_TTL_MS: '200' });
  const skewFile = join(tmp, 'skew'); writeFileSync(skewFile, '0');
  run('npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/client-api'), { STORAGE_GATEWAY_URL: HOST, AGGREGATOR_BASE_URL: HOST, INTERNAL_SERVICE_KEY: 'ik', CLIENT_API_PORT: '19621', CLIENT_JWT_SECRET: 'demo-secret', SKEW_FILE: skewFile, NODE_OPTIONS: `--require ${join(ROOT, 'scripts/demo/skew-preload.cjs')}` });
  await until('host up', async () => (await fetch(`${HOST}/health`)).ok);
  await until('client-api up', async () => (await fetch(`${API}/health`)).ok);

  // Seed 1200 events over the four sources, shuffled write order, distinct ingested_at and occurred_at.
  const SRC: Array<[HazardSource, HazardType]> = [['BMKG', 'SEISMIC'], ['PVMBG', 'VOLCANIC'], ['SATELIT', 'WILDFIRE'], ['SENSOR_PANTAI', 'COASTAL']];
  const N = 1200;
  const rows: StoredHazardEvent[] = Array.from({ length: N }, (_, i) => {
    const [source, hazard_type] = SRC[i % 4];
    const ref = `ev-${i}`;
    return { hazard_id: hazardId(source, ref), source, source_ref_id: ref, hazard_type, severity: 'WASPADA', area_name: `area-${i % 17}`, latitude: -6, longitude: 106,
      occurred_at: new Date(Date.UTC(2026, 10, 15, 0, 0, (i * 7919) % N)).toISOString(), ingested_at: new Date(Date.UTC(2026, 10, 16, 0, 0, i)).toISOString(), attributes: {}, version: 1 } as StoredHazardEvent;
  });
  const order = rows.map((_, i) => i).sort((a, b) => ((a * 2654435761) % 1000003) - ((b * 2654435761) % 1000003));
  for (const i of order) await ring.upsertEvent(rows[i], { fence: 1, fenceName: 'k3', idempotencyKey: `k3-${i}`, correlationId: 'k3' });

  // K3a: paginated Audit walk, all sources, equals the sorted ground truth.
  const walk: string[] = []; let cursor: string | undefined; let pages = 0;
  do {
    const r = await fetch(`${HOST}/internal/audit/events?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: { authorization: 'Bearer audit-secret' } });
    const body = await r.json() as any;
    walk.push(...body.items.map((e: any) => e.hazard_id)); cursor = body.next_cursor ?? undefined; pages++;
  } while (cursor);
  const truth = [...rows].sort((a, b) => (a.ingested_at < b.ingested_at ? -1 : a.ingested_at > b.ingested_at ? 1 : a.hazard_id < b.hazard_id ? -1 : 1)).map((e) => e.hazard_id);
  check(`K3: paginated Audit walk over all ${N} events in ${pages} pages equals the sorted ground truth (ingested_at, hazard_id), no gap or repeat`, walk.length === N && walk.every((id, i) => id === truth[i]));

  // K3b: "latest 50 across all types" through client-api.
  const tok = (scope: string, expiresIn: number) => jwt.sign({ scope, purpose: 'access' }, 'demo-secret', { subject: `${scope}-user`, audience: 'bnpb-client', expiresIn, algorithm: 'HS256' });
  const latestRes = await fetch(`${API}/hazard-events?limit=50`, { headers: { authorization: `Bearer ${tok('media', 300)}` } });
  const latest = await latestRes.json() as any;
  if (!latest.data) line(`diagnostics: /hazards -> ${latestRes.status} ${JSON.stringify(latest).slice(0, 300)}`);
  const want = [...rows].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1)).slice(0, 50).map((e) => e.hazard_id);
  const got = (latest.data as any[]).map((e) => e.hazard_id);
  if (!(got.length === 50 && got.every((id, i) => id === want[i]))) line(`diagnostics: first got ${JSON.stringify(got.slice(0, 5))} want ${JSON.stringify(want.slice(0, 5))}; sample ${JSON.stringify((latest.data as any[])[0])}`);
  const types = new Set((latest.data as any[]).map((e) => e.hazard_type));
  check(`K3: GET /hazard-events?limit=50 through client-api returns the 50 newest events of all types, newest first (${types.size} hazard types present)`, got.length === 50 && got.every((id, i) => id === want[i]) && types.size > 1);

  // X-09: wall-clock shift of the client-api process; the token lives 20 s, the declared tolerance is 60 s.
  const probe = async (offsetMs: number) => { writeFileSync(skewFile, String(offsetMs)); await sleep(120); const t = tok('media', 20); const r = await fetch(`${API}/hazard-events?limit=1`, { headers: { authorization: `Bearer ${t}` } }); return r.status; };
  const s0 = await probe(0), s45 = await probe(45_000), sm30 = await probe(-30_000), s100 = await probe(100_000);
  line(`  client-api clock shifted: 0 s -> ${s0}, +45 s -> ${s45}, -30 s -> ${sm30}, +100 s -> ${s100} (token valid 20 s, tolerance 60 s)`);
  check('X-09: no false 401 for +45 s and -30 s clock shifts', s0 === 200 && s45 === 200 && sm30 === 200);
  check('X-09: a clock beyond the tolerance (+100 s, token expired 80 s ago) is still rejected (401), so the tolerance is bounded', s100 === 401);

  line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs) { try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ } } rmSync(tmp, { recursive: true, force: true }); });
