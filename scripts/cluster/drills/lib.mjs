// Shared helpers for the cluster drills. Plain Node >= 18 (no dependencies); talks to the cluster through kubectl and to the services through temporary NodePort Services.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NS = process.env.NS ?? 'sistem-informasi-kebencanaan-bnpb';
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../../..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => new Date().toISOString().slice(11, 19);

export function kubectl(args, { ns = true, allowFail = false } = {}) {
  const full = ns ? ['-n', NS, ...args] : args;
  const r = spawnSync('kubectl', full, { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`kubectl ${full.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
}
export const secret = (key, name = 'bnpb-secrets') => Buffer.from(kubectl(['get', 'secret', name, '-o', `jsonpath={.data.${key}}`]), 'base64').toString('utf8');

// Evidence file: header (what, when, where) then every logged line; verdict lines start with [PASS]/[FAIL].
export class Evidence {
  constructor(dir, name, what) {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
    this.dir = join(REPO, '..', 'AAT-docs', 'm2', 'evidence', dir);
    mkdirSync(this.dir, { recursive: true });
    this.file = join(this.dir, `${stamp}_${name}.txt`);
    this.checks = [];
    const nodes = kubectl(['get', 'nodes', '--no-headers', '-o', 'custom-columns=NAME:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion'], { ns: false, allowFail: true }).replace(/\s+/g, ' ').split('\n').join('; ');
    const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
    writeFileSync(this.file, [`# ${what}`, `# date: ${new Date().toISOString()}  label: PROSES NYATA di cluster k3s (bukan simulasi)`, `# nodes: ${nodes}`, `# code: AAT-bebasss @ ${commit}; drill: scripts/cluster/drills/${name}.mjs`, ''].join('\n'));
  }
  log(s) { const l = `[${now()}] ${s}`; console.log(l); appendFileSync(this.file, l + '\n'); }
  check(name, ok, detail = '') { this.checks.push(ok); this.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` (${detail})` : ''}`); }
  done() { const ok = this.checks.every(Boolean); this.log(`RESULT: ${ok ? 'PASS' : 'FAIL'}  -> ${this.file}`); process.exitCode = ok ? 0 : 1; }
}

// Temporary NodePort in front of a Deployment (a port-forward would pin one pod, which is exactly what these drills kill).
const created = [];
export function nodeIp() { return process.env.NODE_IP ?? kubectl(['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'], { ns: false }); }
export function expose(deploy, port) {
  const name = `${deploy}-drill`;
  kubectl(['expose', 'deployment', deploy, '--name', name, '--type=NodePort', '--port', String(port), '--target-port', String(port)], { allowFail: true });
  created.push(name);
  const np = kubectl(['get', 'svc', name, '-o', 'jsonpath={.spec.ports[0].nodePort}']);
  return `http://${nodeIp()}:${np}`;
}
export function cleanup() { for (const n of created) kubectl(['delete', 'svc', n, '--ignore-not-found'], { allowFail: true }); }
process.on('exit', cleanup);

export async function timed(url, init = {}, timeoutMs = 5000) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, ms: performance.now() - t0, body, text };
  } catch (e) {
    return { status: 0, ms: performance.now() - t0, body: null, text: String(e) };
  }
}
export const p95 = (xs) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };

export async function until(what, fn, ms = 120_000, step = 1000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(step); }
}

export function audit(base) {
  const token = secret('AUDIT_TOKEN');
  const h = { authorization: `Bearer ${token}` };
  return {
    get: (path) => timed(`${base}${path}`, { headers: h }),
    checksum: async (source) => (await timed(`${base}/internal/audit/checksum?source=${source}`, { headers: h })).body,
    ring: async () => (await timed(`${base}/internal/audit/ring`, { headers: h })).body,
    placement: async () => (await timed(`${base}/internal/audit/placement`, { headers: h })).body,
    // Every event of every source, paged with the Audit cursor (limit 1000).
    allEvents: async (source) => { const out = []; let cursor; do { const r = await timed(`${base}/internal/audit/events?limit=1000${source ? `&source=${source}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: h }, 30000); if (r.status !== 200) throw new Error(`audit events ${r.status}`); out.push(...r.body.items); cursor = r.body.next_cursor ?? undefined; } while (cursor); return out; },
    unprocessed: async (source) => (await timed(`${base}/internal/audit/unprocessed?limit=1000${source ? `&source=${source}` : ''}`, { headers: h })).body,
    fieldReports: async () => (await timed(`${base}/internal/audit/field-reports?limit=1000`, { headers: h })).body,
  };
}

// Client access tokens (media / lapangan / internal) through auth-service.
export async function clientToken(authBase, role) {
  const up = role.toUpperCase();
  const r = await timed(`${authBase}/auth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: secret(`AUTH_${up}_CLIENT_ID`), client_secret: secret(`AUTH_${up}_CLIENT_SECRET`) }) });
  if (r.status !== 200) throw new Error(`token for ${role}: HTTP ${r.status}`);
  return r.body.access_token;
}

export const leaseHolder = (name) => kubectl(['get', 'lease', name, '-o', 'jsonpath={.spec.holderIdentity}'], { allowFail: true });
export const leaseTransitions = (name) => Number(kubectl(['get', 'lease', name, '-o', 'jsonpath={.spec.leaseTransitions}'], { allowFail: true }) || -1);
export function runTester(name) { return kubectl(['exec', '-n', 'tester-agent', 'daemonset/tester-agent', '--', '/app', 'run', 'practice', name], { ns: false, allowFail: true }); }
export function testerLogs() { return kubectl(['logs', '-n', 'tester-agent', '-l', 'app=tester-agent', '--tail=40'], { ns: false, allowFail: true }); }
export const podsOf = (app) => kubectl(['get', 'pods', '-l', `app=${app}`, '-o', 'jsonpath={range .items[*]}{.metadata.name}{" "}{.spec.nodeName}{" "}{.status.phase}{"\\n"}{end}']).split('\n').filter(Boolean).map((l) => { const [name, node, phase] = l.split(' '); return { name, node, phase }; });
export function scale(deploy, n) { kubectl(['scale', `deployment/${deploy}`, `--replicas=${n}`]); }
// BMKG/PVMBG mocks keep producing events; scale them to 0 when a drill needs stable checksums, and restore them afterwards.
export function freezeSources(ev) { for (const d of ['bmkg-mock', 'pvmbg-mock']) { scale(d, 0); } ev.log('mocks bmkg-mock, pvmbg-mock scaled to 0 so Audit checksums of BMKG/PVMBG are stable (restored at the end)'); return () => { for (const d of ['bmkg-mock', 'pvmbg-mock']) scale(d, 1); ev.log('mocks restored to 1 replica'); }; }
