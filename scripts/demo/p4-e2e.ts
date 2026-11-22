// P4 on real processes: the satellite-processor (real process, Lease leader, ring through the gateway) over the fixture feed (real captured frames).
// Compares its final events with the in-process reference digest, kills the leader repeatedly while the feed also drops the connection, then replays a 108k-frame backlog.
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';

const ROOT = join(__dirname, '../..');
const procs = new Set<ChildProcess>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const sig = (p: ChildProcess, s: NodeJS.Signals) => { try { process.kill(-p.pid!, s); } catch { /* gone */ } };
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };
const run = (cmd: string, args: string[], cwd: string, env: Record<string, string>) => { const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: process.env.DEMO_LOGS ? 'inherit' : 'ignore', detached: true }); procs.add(p); return p; };
async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(100); }
}
const j = (url: string) => fetch(url).then((r) => r.json() as Promise<any>);
const IN_PROCESS_REFERENCE_SHA = 'd11898de253f4d7c'; // fault-free in-process export, evidence/P4/K5/2026-11-16_crash-exactness.txt

interface Stack { ring: HttpStorageClient; sat: (id: string) => ChildProcess; feed: string; lease: () => Promise<any>; stop: () => void }
async function stack(base: number, feedEnv: Record<string, string>): Promise<Stack> {
  const tmp = mkdtempSync(join(tmpdir(), 'p4-'));
  const own: ChildProcess[] = [];
  const keep = (p: ChildProcess) => { own.push(p); return p; };
  const ports = [base, base + 1, base + 2];
  const STORAGE_UNITS = ports.map((p) => `http://127.0.0.1:${p}`).join(',');
  ports.forEach((p, i) => keep(run('node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), { STORAGE_UNIT_PORT: String(p), STORAGE_UNIT_ID: `unit-${i}`, NODE_NAME: `node-${i}`, STORAGE_DATA_DIR: join(tmp, `u${i}`) })));
  const ring = new HttpStorageClient({ units: await discoverUnits({ STORAGE_UNITS }, 20), stateTtlMs: 0 });
  await ring.repair();
  const kubeP = base + 10, hostP = base + 11, feedP = base + 12;
  keep(run('npx', ['tsx', 'scripts/fake-apiserver.ts'], join(ROOT, 'services/aggregator'), { KUBE_API_PORT: String(kubeP), LEASE_NAMESPACE: 'bnpb' }));
  keep(run('npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), { STORAGE_UNITS, AGGREGATOR_PORT: String(hostP), INTERNAL_SERVICE_KEY: 'ik', STORAGE_STATE_TTL_MS: '200' }));
  keep(run('node', ['tools/feed-fixture-server/server.mjs'], ROOT, { PORT: String(feedP), FIXTURE_TOKEN: 'tok', ...feedEnv }));
  await until('host up', async () => (await fetch(`http://127.0.0.1:${hostP}/internal/storage/ringStatus`, { method: 'POST', headers: { 'x-internal-key': 'ik', 'content-type': 'application/json' }, body: '{}' })).ok);
  let n = 0;
  return {
    ring, feed: `http://127.0.0.1:${feedP}`,
    lease: () => j(`http://127.0.0.1:${kubeP}/apis/coordination.k8s.io/v1/namespaces/bnpb/leases/satellite`).catch(() => null),
    sat: (id) => keep(run('npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/satellite-processor'), {
      STORAGE_GATEWAY_URL: `http://127.0.0.1:${hostP}`, INTERNAL_SERVICE_KEY: 'ik', KUBE_API_URL: `http://127.0.0.1:${kubeP}`, LEASE_NAMESPACE: 'bnpb', LEASE_DURATION_SECONDS: '4', LEASE_RENEW_INTERVAL_MS: '500',
      SAT_FEED_BASE_URL: `http://127.0.0.1:${feedP}`, SAT_GROUP_TOKEN: 'tok', SATELLITE_PORT: String(base + 20 + n++), POD_NAME: id, SAT_RECONNECT_MIN_MS: '100',
    })),
    stop: () => { for (const p of own) sig(p, 'SIGKILL'); rmSync(tmp, { recursive: true, force: true }); },
  };
}
async function exportEvents(ring: HttpStorageClient): Promise<string> {
  const all: any[] = []; let cursor: string | undefined;
  do { const pg = await ring.listEvents({ source: 'SATELIT', limit: 1000, cursor }); all.push(...pg.items); cursor = pg.next_cursor ?? undefined; } while (cursor);
  const events = all.map(({ ingested_at: _i, ...rest }) => rest).sort((a, b) => (a.hazard_id < b.hazard_id ? -1 : 1));
  return JSON.stringify(events, null, 1) + '\n';
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
async function drained(ring: HttpStorageClient, stableFor = 40): Promise<number> {
  let last = -1, stable = 0;
  return until('feed drained', async () => { const c = (await ring.checksum('SATELIT')).count; stable = c === last ? stable + 1 : 0; last = c; return stable >= stableFor && c > 0 ? c : null; }, 240_000);
}

// Histogram quantile from the processor's cumulative buckets (upper bound of the first bucket holding the q-th sample).
function bucketQuantile(metrics: string, name: string, q: number): number | null {
  const rows = [...metrics.matchAll(new RegExp(`^${name}_bucket\\{le="([^"]+)"\\} (\\d+)`, 'gm'))].map((m) => ({ le: m[1] === '+Inf' ? Infinity : Number(m[1]), n: Number(m[2]) }));
  const total = rows.find((r) => r.le === Infinity)?.n ?? 0;
  if (!total) return null;
  return rows.find((r) => r.n >= q * total)?.le ?? null;
}

// D. P4-K4 as worded: a fast burst, then "back up to date within 60 s after the burst ends", p95 frame->stored, lag over time.
async function scenarioD(): Promise<void> {
  const FPS = Number(process.env.BURST_FPS ?? 3000);
  const CYCLES = Number(process.env.BURST_CYCLES ?? 36);
  const d = await stack(19600, { REPEAT_CYCLES: String(CYCLES), FRAMES_PER_SECOND: String(FPS) });
  const info = await j(`${d.feed}/admin/info`);
  const satPort = 19600 + 20;
  d.sat('sat-1');
  const t0 = Date.now();
  const series: Array<{ t: number; sent: number; committed: number; lag: number | null }> = [];
  let burstEnd: number | null = null, caughtUp: number | null = null;
  for (;;) {
    const [st, sat] = await Promise.all([j(`${d.feed}/admin/stats`).catch(() => null), j(`http://127.0.0.1:${satPort}/internal/satellite/stats`).catch(() => null)]);
    const t = (Date.now() - t0) / 1000;
    if (st && sat) {
      series.push({ t, sent: st.framesSent, committed: sat.committed_offset, lag: sat.lag });
      if (burstEnd === null && st.framesSent >= info.total) burstEnd = t;
      if (burstEnd !== null && caughtUp === null && sat.committed_offset >= info.last_id) caughtUp = t;
    }
    if (caughtUp !== null || t > 400) break;
    await sleep(500);
  }
  const metrics = await (await fetch(`http://127.0.0.1:${satPort}/metrics`)).text();
  const p95 = bucketQuantile(metrics, 'bnpb_sat_event_to_store_seconds', 0.95);
  const count = await drained(d.ring, 20);
  const dump = JSON.parse(await exportEvents(d.ring)) as any[];
  const dup = dump.length - new Set(dump.map((e) => e.hazard_id)).size;
  const maxLag = Math.max(...series.map((x) => x.lag ?? 0));
  line(`D burst: ${info.total} frames offered at ${FPS}/s; sampled ${series.length} points every 0.5 s`);
  for (const x of series.filter((_, i) => i % Math.max(1, Math.floor(series.length / 12)) === 0)) line(`  t=${x.t.toFixed(1)}s sent=${x.sent} committed=${x.committed} lag=${x.lag}`);
  line(`D burst ended (last frame sent) at ${burstEnd?.toFixed(1)} s; caught up (committed offset = last offset ${info.last_id}) at ${caughtUp?.toFixed(1)} s => ${burstEnd !== null && caughtUp !== null ? (caughtUp - burstEnd).toFixed(1) : 'n/a'} s after the burst; max lag ${maxLag} frames; frame->stored p95 <= ${p95} s (histogram bucket upper bound); ${count} events, ${dup} duplicates`);
  check(`K4: no data lost or duplicated in the burst (${count} events = ${CYCLES} x 51 expected, ${dup} duplicates)`, count === 51 * CYCLES && dup === 0);
  check(`K4: up to date within 60 s after the burst ends (${burstEnd !== null && caughtUp !== null ? (caughtUp - burstEnd).toFixed(1) : 'n/a'} s)`, burstEnd !== null && caughtUp !== null && caughtUp - burstEnd <= 60);
  check(`K4: p95 latency frame->stored is reported (<= ${p95} s) and lag is observable (max ${maxLag} frames via /internal/satellite/stats and bnpb_sat_offset_lag)`, p95 !== null && maxLag > 0);
  d.stop();
}

async function main(): Promise<void> {
  if (process.env.ONLY === 'D') { await scenarioD(); line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`); process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1; return; }
  // A. fault-free
  const a = await stack(19300, { FRAMES_PER_SECOND: '1500' });
  a.sat('sat-1');
  await drained(a.ring);
  const cleanExport = await exportEvents(a.ring);
  const clean = JSON.parse(cleanExport) as any[];
  line(`fault-free real-process run: ${clean.length} satellite events, digest ${sha(cleanExport)} (in-process reference ${IN_PROCESS_REFERENCE_SHA})`);
  check('K1/K3/FIRE: one event per fire, no duplicate hazard ids', clean.length === 51 && new Set(clean.map((e) => e.hazard_id)).size === clean.length);
  check('K1/K3/FIRE: ring result is byte-identical to the in-process pipeline result (ingested_at ignored)', sha(cleanExport) === IN_PROCESS_REFERENCE_SHA);
  a.stop(); await sleep(500);

  // B. leader killed repeatedly while the feed also drops the connection
  const b = await stack(19400, { FRAMES_PER_SECOND: '300', DISCONNECT_EVERY_N: '250' });
  const sats = new Map<string, ChildProcess>();
  const start = (id: string) => sats.set(id, b.sat(id));
  const holderOf = async () => (await b.lease())?.spec?.holderIdentity as string | undefined;
  start('sat-a'); start('sat-b');
  await until('leader', holderOf);
  let kills = 0, seed = 20261121;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  while (kills < 4) {
    await sleep(1200 + Math.floor(rnd() * 1500));
    const h = await holderOf();
    const victim = h ? sats.get(h) : undefined;
    if (!h || !victim) continue;
    sig(victim, 'SIGKILL'); sats.delete(h); kills++;
    start(`sat-r${kills}`);
    await sleep(300);
  }
  const faulted = await drained(b.ring, 60);
  const faultedExport = await exportEvents(b.ring);
  const stats = await j(`${b.feed}/admin/stats`);
  line(`leader killed ${kills}x, feed dropped the connection every 250 frames (${stats.connections ?? '?'} connections served): ${faulted} events, digest ${sha(faultedExport)}`);
  check('K5/K8: after repeated leader kills and feed disconnects the result is byte-identical to the fault-free run (no loss, no duplicates)', faultedExport === cleanExport);
  b.stop(); await sleep(500);

  // C. 108k-frame backlog
  const c = await stack(19500, { REPEAT_CYCLES: '36' });
  const info = await j(`${c.feed}/admin/info`);
  const t0 = Date.now();
  c.sat('sat-1');
  await until('first event', async () => (await c.ring.checksum('SATELIT')).count > 0);
  const count = await drained(c.ring, 60);
  const burstExport = await exportEvents(c.ring);
  const dup = (JSON.parse(burstExport) as any[]).length - new Set((JSON.parse(burstExport) as any[]).map((e) => e.hazard_id)).size;
  line(`backlog of ${info.total} frames: ${count} events stored, ${((Date.now() - t0) / 1000).toFixed(1)} s from start to stable (includes ${(60 * 0.1).toFixed(0)} s stability wait)`);
  check(`K4: ${info.total} frames processed with no duplicates (${count} events, ${dup} duplicates)`, info.total >= 100_000 && dup === 0 && count > 51);
  c.stop();
  await scenarioD();

  line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs) sig(p, 'SIGKILL'); });
