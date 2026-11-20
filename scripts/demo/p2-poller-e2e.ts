// P2-K2..K5 for the BMKG/PVMBG pollers on real processes: two poller hosts share Leases; the mocks' request logs show who called upstream.
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';

const ROOT = join(__dirname, '../..');
const jwt = createRequire(join(ROOT, 'services/client-api/package.json'))('jsonwebtoken') as { sign: (p: object, s: string, o: object) => string };
const procs = new Set<ChildProcess>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const sig = (p: ChildProcess, s: NodeJS.Signals) => { try { process.kill(-p.pid!, s); } catch { /* gone */ } };
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };
const j = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers }).then((r) => r.json() as Promise<any>);
const INTERVAL = 2000;

function run(cmd: string, args: string[], cwd: string, env: Record<string, string>, out?: number): ChildProcess {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: out !== undefined ? ['ignore', out, out] : process.env.DEMO_LOGS ? 'inherit' : 'ignore', detached: true });
  procs.add(p);
  return p;
}
async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(100); }
}

interface Env {
  ring: HttpStorageClient; tmp: string; stop: () => void;
  holder: (name: string) => Promise<string | undefined>; transitions: (name: string) => Promise<number>;
  poller: (id: string, skewFile?: string) => ChildProcess; logOf: (id: string) => string;
  callers: (since?: string) => Promise<Array<{ path: string; caller: string; ts: string }>>;
  bmkgCount: () => Promise<number>;
}

async function stack(base: number): Promise<Env> {
  const tmp = mkdtempSync(join(tmpdir(), 'p2p-'));
  const own: ChildProcess[] = []; const fds: number[] = [];
  const keep = (p: ChildProcess) => { own.push(p); return p; };
  const ports = [base, base + 1, base + 2];
  const STORAGE_UNITS = ports.map((p) => `http://127.0.0.1:${p}`).join(',');
  ports.forEach((p, i) => keep(run('node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), { STORAGE_UNIT_PORT: String(p), STORAGE_UNIT_ID: `unit-${i}`, NODE_NAME: `node-${i}`, STORAGE_DATA_DIR: join(tmp, `u${i}`) })));
  const ring = new HttpStorageClient({ units: await discoverUnits({ STORAGE_UNITS }, 20), stateTtlMs: 0 });
  await ring.repair();
  const kubeP = base + 10, bmkgP = base + 11, pvmbgP = base + 12;
  keep(run('npx', ['tsx', 'scripts/fake-apiserver.ts'], join(ROOT, 'services/aggregator'), { KUBE_API_PORT: String(kubeP), LEASE_NAMESPACE: 'bnpb' }));
  keep(run('node', ['dist/services/bmkg-mock/src/index.js'], join(ROOT, 'services/bmkg-mock'), { BMKG_PORT: String(bmkgP), BMKG_API_KEY: 'bk', BMKG_DELAY_MIN_MS: '10', BMKG_DELAY_MAX_MS: '30' }));
  keep(run('node', ['dist/services/pvmbg-mock/src/index.js'], join(ROOT, 'services/pvmbg-mock'), { PVMBG_PORT: String(pvmbgP), PVMBG_JWT_SECRET: 'ps', PVMBG_DELAY_MIN_MS: '10', PVMBG_DELAY_MAX_MS: '30' }));
  const kube = `http://127.0.0.1:${kubeP}`, bmkg = `http://127.0.0.1:${bmkgP}`;
  await until('mocks up', async () => (await fetch(`${bmkg}/health`)).ok && (await fetch(`http://127.0.0.1:${pvmbgP}/health`)).ok);
  const token = jwt.sign({ sub: 'aggregator' }, 'ps', { audience: 'pvmbg', expiresIn: '1h' });
  const logs = new Map<string, string>();
  const lease = (n: string) => j(`${kube}/apis/coordination.k8s.io/v1/namespaces/bnpb/leases/${n}`).catch(() => null);
  return {
    ring, tmp,
    holder: async (n) => (await lease(n))?.spec?.holderIdentity,
    transitions: async (n) => Number((await lease(n))?.spec?.leaseTransitions ?? -1),
    poller: (id, skewFile) => {
      const file = join(tmp, `${id}.log`); logs.set(id, file);
      const fd = openSync(file, 'a'); fds.push(fd);
      return keep(run('npx', ['tsx', 'scripts/poller-host.ts'], join(ROOT, 'services/aggregator'), {
        STORAGE_UNITS, KUBE_API_URL: kube, LEASE_NAMESPACE: 'bnpb', LEASE_DURATION_SECONDS: '4', LEASE_RENEW_INTERVAL_MS: '500', POD_NAME: id, HOSTNAME: id,
        BMKG_BASE_URL: bmkg, BMKG_API_KEY: 'bk', PVMBG_BASE_URL: `http://127.0.0.1:${pvmbgP}`, PVMBG_ACCESS_TOKEN: token, POLL_INTERVAL_MS: String(INTERVAL),
        ...(skewFile ? { SKEW_FILE: skewFile, NODE_OPTIONS: `--require ${join(ROOT, 'scripts/demo/skew-preload.cjs')}` } : {}),
      }, fd));
    },
    logOf: (id) => readFileSync(logs.get(id)!, 'utf8'),
    callers: async (since) => ((await j(`${bmkg}/admin/request-log${since ? `?since=${encodeURIComponent(since)}` : ''}`)).data as any[]).filter((e) => e.caller_instance).map((e) => ({ path: e.path, caller: e.caller_instance, ts: e.ts })),
    bmkgCount: async () => ((await j(`${bmkg}/seismic-events`, { 'x-bmkg-key': 'bk' })).data as any[]).length,
    stop: () => { for (const p of own) sig(p, 'SIGKILL'); for (const f of fds) try { closeSync(f); } catch { /* closed */ } rmSync(tmp, { recursive: true, force: true }); },
  };
}
const uniq = (xs: string[]) => [...new Set(xs)];
// The BMKG mock keeps producing events, so "equal" means: within a few polls the ring holds exactly the mock's events (never more = no duplicates, never fewer = no gap).
async function converges(env: Env): Promise<{ ok: boolean; stored: number; mock: number }> {
  let stored = 0, mock = 0;
  for (let i = 0; i < 12; i++) {
    stored = (await env.ring.listEvents({ source: 'BMKG', limit: 1000 })).items.length;
    mock = await env.bmkgCount();
    if (stored === mock) return { ok: true, stored, mock };
    await sleep(500);
  }
  return { ok: false, stored, mock };
}

async function main(): Promise<void> {
  // K2 + K3
  const a = await stack(18900);
  const p = new Map<string, ChildProcess>([['poller-1', a.poller('poller-1')], ['poller-2', a.poller('poller-2')]]);
  await until('both leases held', async () => (await a.holder('bmkg')) && (await a.holder('pvmbg')));
  const t0 = new Date().toISOString();
  await sleep(11_000);
  const win = await a.callers(t0);
  const bmkgCallers = uniq(win.filter((e) => e.path.startsWith('/seismic')).map((e) => e.caller));
  const bmkgReqs = win.filter((e) => e.path.startsWith('/seismic')).length;
  const lb = await a.holder('bmkg'), lp = await a.holder('pvmbg');
  line(`two pollers, 11 s window (interval ${INTERVAL} ms): BMKG leader=${lb}, PVMBG leader=${lp}; /seismic-events calls=${bmkgReqs} from ${bmkgCallers.join(',')}`);
  check('K2: only the BMKG lease holder called the BMKG mock (one caller_instance in its request log)', bmkgCallers.length === 1 && bmkgCallers[0] === lb);
  check(`K2: upstream load is one poller's worth (${bmkgReqs} calls in 11 s at ${INTERVAL} ms, not double)`, bmkgReqs >= 4 && bmkgReqs <= 7);
  const k2 = await converges(a);
  line(`  BMKG events in the mock: ${k2.mock}; stored in the ring: ${k2.stored}`);
  check('K2: every BMKG event from the mock is stored exactly once (ring == mock, no duplicates)', k2.ok);

  const before = new Date().toISOString();
  const tk = Date.now();
  sig(p.get(lb!)!, 'SIGKILL');
  const next = await until('BMKG takeover', async () => { const h = await a.holder('bmkg'); return h && h !== lb ? h : null; }, 30_000);
  const takeover = Date.now() - tk;
  await sleep(2 * INTERVAL + 1000);
  const after = (await a.callers(before)).filter((e) => e.path.startsWith('/seismic'));
  line(`  ${lb} killed; ${next} took the BMKG lease after ${takeover} ms (leaseTransitions ${await a.transitions('bmkg')})`);
  check(`K3: another instance continues within 60 s (took over in ${takeover} ms)`, takeover <= 60_000);
  check('K3: after takeover only the new leader calls upstream', after.some((e) => e.caller === next) && after.every((e) => e.caller !== lb || e.ts <= new Date(tk + 500).toISOString()));
  const k3 = await converges(a);
  line(`  after takeover: mock ${k3.mock}, ring ${k3.stored}`);
  check('K3: no gap and no duplicates (ring converges to exactly the mock events)', k3.ok);
  a.stop(); await sleep(500);

  // K4: clock shifts
  const b = await stack(19000);
  const f1 = join(b.tmp, 's1'), f2 = join(b.tmp, 's2');
  writeFileSync(f1, '45000'); writeFileSync(f2, '-30000');
  b.poller('poller-1', f1); b.poller('poller-2', f2);
  await until('both leases held', async () => (await b.holder('bmkg')) && (await b.holder('pvmbg')));
  const tb0 = [await b.transitions('bmkg'), await b.transitions('pvmbg')];
  const hs = new Set([await b.holder('bmkg')]);
  const poll = setInterval(() => void b.holder('bmkg').then((h) => h && hs.add(h)), 100);
  const tb = new Date().toISOString();
  await sleep(6000); writeFileSync(f1, '-30000'); writeFileSync(f2, '45000'); await sleep(7000);
  clearInterval(poll);
  const calls = uniq((await b.callers(tb)).filter((e) => e.path.startsWith('/seismic')).map((e) => e.caller));
  check(`K4: wall clocks +45 s / -30 s then swapped: one BMKG leader throughout (${[...hs].join(',')}) and one upstream caller (${calls.join(',')})`, hs.size === 1 && calls.length === 1);
  check(`K4: no spurious takeover (leaseTransitions bmkg ${tb0[0]}->${await b.transitions('bmkg')}, pvmbg ${tb0[1]}->${await b.transitions('pvmbg')})`, (await b.transitions('bmkg')) === tb0[0] && (await b.transitions('pvmbg')) === tb0[1]);
  b.stop(); await sleep(500);

  // K5: freeze
  const c = await stack(19100);
  const pc = new Map<string, ChildProcess>([['poller-1', c.poller('poller-1')], ['poller-2', c.poller('poller-2')]]);
  await until('both leases held', async () => (await c.holder('bmkg')) && (await c.holder('pvmbg')));
  await sleep(4000);
  const old = (await c.holder('bmkg'))!;
  sig(pc.get(old)!, 'SIGSTOP');
  const fresh = await until('takeover after freeze', async () => { const h = await c.holder('bmkg'); return h && h !== old ? h : null; }, 30_000);
  await sleep(2500);
  const thaw = new Date().toISOString();
  sig(pc.get(old)!, 'SIGCONT');
  await sleep(9000);
  const stale = (await c.callers(thaw)).filter((e) => e.path.startsWith('/seismic') && e.caller === old);
  const log = c.logOf(old).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const afterThaw = log.filter((e: any) => e.timestamp > thaw && e.source === 'BMKG');
  const okAfter = afterThaw.filter((e: any) => e.message === 'source poll completed').length;
  const failedAfter = afterThaw.filter((e: any) => e.message === 'source poll failed');
  line(`  ${old} frozen (SIGSTOP) -> ${fresh} became BMKG leader; after SIGCONT the old instance: upstream calls=${stale.length}, polls completed=${okAfter}, polls failed=${failedAfter.length}${failedAfter[0] ? ` (e.g. ${String(failedAfter[0].err).slice(0, 80)})` : ''}`);
  const msgs = new Map<string, number>();
  for (const e of log.filter((x: any) => x.timestamp > thaw)) msgs.set(`${e.source ?? '-'}:${e.message}`, (msgs.get(`${e.source ?? '-'}:${e.message}`) ?? 0) + 1);
  line(`  old instance log after thaw: ${[...msgs].map(([k, v]) => `${k}×${v}`).join(', ') || '(nothing)'}`);
  check('K5: after thaw the old instance completed no BMKG poll (its writes were refused or it did not poll)', okAfter === 0);
  check('K5: it did not take the lease back', (await c.holder('bmkg')) === fresh);
  const k5 = await converges(c);
  line(`  after the freeze drill: mock ${k5.mock}, ring ${k5.stored}`);
  check('K5: ring converges to exactly the mock events (no loss, no duplicates)', k5.ok);
  c.stop();

  line(`RESULT: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
main().catch((e) => { process.stderr.write(`${e}\n`); process.exitCode = 1; }).finally(() => { for (const p of procs) sig(p, 'SIGKILL'); });
