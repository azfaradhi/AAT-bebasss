// P5-K5 on real processes: the real client-api (JWT auth + priority admission) in front of the real aggregator read path and a 3-unit ring.
// A node load generator sends far more media concurrency than the admission limits allow, next to a small lapangan stream; the admission limits are lowered to match one laptop.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hazardId } from '../../shared-types/src/m2/ids';
import type { HazardEvent } from '../../shared-types/src/m2/types';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';

const ROOT = join(__dirname, '../..');
const jwt = createRequire(join(ROOT, 'services/client-api/package.json'))('jsonwebtoken') as { sign: (p: object, s: string, o: object) => string };
const tmp = mkdtempSync(join(tmpdir(), 'shed-'));
const procs: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };
const run = (cmd: string, args: string[], cwd: string, env: Record<string, string>) => procs.push(spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: process.env.DEMO_LOGS ? 'inherit' : 'ignore', detached: true }));
const p95 = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };
async function until(what: string, fn: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) { if (await fn().catch(() => false)) return; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(150); }
}

const MEDIA = Number(process.env.MEDIA_CONC ?? 120), FIELD = Number(process.env.FIELD_CONC ?? 8), DURATION = Number(process.env.DURATION_S ?? 15);
const MAX = 16, RESERVED = 6, MEDIA_MAX = 8;

async function main(): Promise<void> {
  const ports = [19910, 19911, 19912];
  ports.forEach((p, i) => run('node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), { STORAGE_UNIT_PORT: String(p), STORAGE_UNIT_ID: `unit-${i}`, NODE_NAME: `node-${i}`, STORAGE_DATA_DIR: join(tmp, `u${i}`) }));
  const STORAGE_UNITS = ports.map((p) => `http://127.0.0.1:${p}`).join(',');
  const ring = new HttpStorageClient({ units: await discoverUnits({ STORAGE_UNITS }, 20), stateTtlMs: 0 });
  await ring.repair();
  const ctx = { fence: 1, fenceName: 'seed', idempotencyKey: 's', correlationId: 's' };
  for (let i = 0; i < 400; i++) {
    const ref = `shed-${i}`;
    const e: HazardEvent = { hazard_id: hazardId('BMKG', ref), source: 'BMKG', source_ref_id: ref, hazard_type: 'SEISMIC', severity: 'WASPADA', occurred_at: new Date(Date.UTC(2026, 10, 15, 0, 0, i)).toISOString(), area_name: `Area ${i % 20}`, coordinates: { latitude: -8 + (i % 80) / 10, longitude: 95 + (i % 400) / 4 }, description: 'shed demo' };
    await ring.upsertEvent(e, { ...ctx, idempotencyKey: `s-${i}` });
  }
  const AGG = 'http://127.0.0.1:19920', API = 'http://127.0.0.1:19921';
  run('npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), { STORAGE_UNITS, AGGREGATOR_PORT: '19920', INTERNAL_SERVICE_KEY: 'ik', AUDIT_TOKEN: 'audit-secret', STORAGE_STATE_TTL_MS: '200' });
  run('node', ['dist/services/client-api/src/index.js'], join(ROOT, 'services/client-api'), {
    CLIENT_API_PORT: '19921', CLIENT_JWT_SECRET: 'js', INTERNAL_SERVICE_KEY: 'ik', AGGREGATOR_BASE_URL: AGG, AGGREGATOR_REQUEST_TIMEOUT_MS: '3000',
    ADMISSION_MAX_INFLIGHT: String(MAX), ADMISSION_LAPANGAN_RESERVED: String(RESERVED), ADMISSION_MEDIA_MAX_INFLIGHT: String(MEDIA_MAX), ADMISSION_RETRY_AFTER_S: '3',
  });
  await until('stack up', async () => (await fetch(`${AGG}/health`)).ok && (await fetch(`${API}/health`)).ok);
  const token = (scope: string) => jwt.sign({ sub: `${scope}-load`, scope, aud: 'bnpb-client', purpose: 'access' }, 'js', { expiresIn: '10m', algorithm: 'HS256' });
  const tok: Record<string, string> = { media: token('media'), lapangan: token('lapangan') };
  const probe = await fetch(`${API}/api/v1/hazards?limit=50`, { headers: { authorization: `Bearer ${tok.lapangan}` } });
  if (!probe.ok) throw new Error(`probe failed ${probe.status}: ${await probe.text()}`);

  const stat: Record<string, { ok: number; shed: number; retryAfter: number; other: number[]; ms: number[] }> = { media: { ok: 0, shed: 0, retryAfter: 0, other: [], ms: [] }, lapangan: { ok: 0, shed: 0, retryAfter: 0, other: [], ms: [] } };
  let stop = false;
  const worker = async (role: string) => {
    while (!stop) {
      const t = Date.now();
      try {
        const r = await fetch(`${API}/api/v1/hazards?limit=50`, { headers: { authorization: `Bearer ${tok[role]}` } });
        await r.arrayBuffer();
        const s = stat[role]; s.ms.push(Date.now() - t);
        if (r.status === 200) s.ok++; else if (r.status === 429) { s.shed++; if (r.headers.get('retry-after')) s.retryAfter++; } else s.other.push(r.status);
      } catch { stat[role].other.push(0); }
    }
  };
  const pool = [...Array(MEDIA).fill('media'), ...Array(FIELD).fill('lapangan')].map(worker);
  await sleep(DURATION * 1000); stop = true; await Promise.all(pool);
  for (const r of ['media', 'lapangan']) { const s = stat[r]; line(`${r}: 200=${s.ok} 429=${s.shed} (with Retry-After: ${s.retryAfter}) other=${[...new Set(s.other)].join(',') || 'none'} p95=${p95(s.ms).toFixed(0)} ms`); }
  const f = stat.lapangan, m = stat.media;
  line(`load: ${MEDIA} media + ${FIELD} lapangan concurrent clients for ${DURATION} s; admission max_inflight=${MAX}, lapangan_reserved=${RESERVED}, media_max=${MEDIA_MAX}`);
  const fSucc = f.ok / Math.max(1, f.ok + f.shed + f.other.length);
  check(`P5-K5: lapangan is served (${(fSucc * 100).toFixed(1)} % answered 200, target >= 95 %)`, fSucc >= 0.95);
  check(`P5-K5: media is rejected in a controlled way (${m.shed} x 429 with Retry-After on ${m.retryAfter}, no 5xx/timeouts)`, m.shed > 0 && m.retryAfter === m.shed && m.other.length === 0);
  check(`P5-K5: lapangan p95 stays low under overload (${p95(f.ms).toFixed(0)} ms < 1000 ms)`, p95(f.ms) < 1000);
  const metrics = await (await fetch(`${API}/metrics`)).text().catch(() => '');
  line(`metrics: ${metrics.split('\n').filter((l) => l.includes('shed')).slice(0, 3).join(' | ') || 'n/a'}`);
  line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs) { try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ } } rmSync(tmp, { recursive: true, force: true }); });
