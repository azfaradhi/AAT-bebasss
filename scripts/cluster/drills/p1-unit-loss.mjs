// P1-K5 / K6 on k3s WITHOUT powering a VM off: a storage unit leaves (label removed), its data is wiped, it rejoins empty and is repaired;
// then a SECOND unit is lost and wiped. After each loss the BMKG/PVMBG count+checksum must equal the baseline (nothing lost).
//   usage: node scripts/cluster/drills/p1-unit-loss.mjs     env: NODE_IP, SSH_KEY (private key of vboxuser on the VMs), FIRST=node-c SECOND=node-b
import { spawnSync } from 'node:child_process';
import { Evidence, audit, expose, freezeSources, kubectl, sleep, until } from './lib.mjs';

const FIRST = process.env.FIRST ?? 'node-c', SECOND = process.env.SECOND ?? 'node-b';
const IP = { 'node-a': '192.168.56.101', 'node-b': '192.168.56.102', 'node-c': '192.168.56.103' };
const KEY = process.env.SSH_KEY;
const ev = new Evidence('P1/K6', 'cluster-p1-unit-loss', `P1-K5/K6: unit ${FIRST} wiped and rejoined, then unit ${SECOND} wiped; checksums vs baseline`);
const A = audit(expose('aggregator', 8090));
const wipe = (node) => spawnSync('ssh', ['-i', KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', `vboxuser@${IP[node]}`, 'sudo rm -f /var/lib/bnpb/store/*.log; echo wiped'], { encoding: 'utf8' }).stdout.trim();
const snap = async () => { const [b, p, r] = [await A.checksum('BMKG'), await A.checksum('PVMBG'), await A.ring()]; return { b, p, r }; };
const fmt = (s) => `BMKG ${s.b?.count}/${s.b?.checksum?.slice(0, 16)} partial=${s.b?.partial} | PVMBG ${s.p?.count}/${s.p?.checksum?.slice(0, 16)} partial=${s.p?.partial}`;
const ringStr = (r) => (r?.units ?? []).map((u) => `${u.unit}:${u.state}/${u.keys}`).join(' ') + ` redundancy_ok=${r?.redundancy_ok}`;
const same = (x, y) => x.b?.count === y.b?.count && x.b?.checksum === y.b?.checksum && x.p?.count === y.p?.count && x.p?.checksum === y.p?.checksum;
async function lose(node, label) {
  const t0 = Date.now();
  kubectl(['label', 'node', node, 'bnpb/storage-', '--overwrite'], { ns: false, allowFail: true });
  kubectl(['delete', 'pod', '-l', 'app=storage-unit', '--field-selector', `spec.nodeName=${node}`, '--wait=false'], { allowFail: true });
  ev.log(`${label}: ${node} unit removed (label off), ${wipe(node)}`);
  await sleep(3000);
  kubectl(['label', 'node', node, 'bnpb/storage=true', '--overwrite'], { ns: false });
  const ok = await until(`${node} back STABLE`, async () => { const r = await A.ring().catch(() => null); ev.log(`  ring ${ringStr(r)}`); return r?.units?.every((u) => u.state === 'STABLE') && r.redundancy_ok ? r : null; }, 300_000, 5000).catch(() => null);
  return { ok: !!ok, secs: Math.round((Date.now() - t0) / 1000) };
}
try {
  freezeSources(ev);
  await sleep(15_000);
  const base = await snap();
  ev.log(`BASELINE ring ${ringStr(base.r)}`); ev.log(`BASELINE ${fmt(base)}`);
  const k5 = await lose(FIRST, 'K5');
  const s5 = await snap(); ev.log(`after K5 (${k5.secs}s) ring ${ringStr(s5.r)}`); ev.log(`after K5 ${fmt(s5)}`);
  ev.check(`K5: ${FIRST} rejoined empty, STABLE, redundancy_ok in ${k5.secs} s`, k5.ok);
  ev.check('K5: counts+checksums equal the baseline (no event lost)', same(base, s5));
  const k6 = await lose(SECOND, 'K6');
  const s6 = await snap(); ev.log(`after K6 (${k6.secs}s) ring ${ringStr(s6.r)}`); ev.log(`after K6 ${fmt(s6)}`);
  ev.check(`K6: second loss (${SECOND}) recovered to STABLE in ${k6.secs} s`, k6.ok);
  ev.check('K6: counts+checksums equal the baseline after the second loss', same(base, s6));
} catch (e) { ev.log(`ERROR ${e.stack ?? e}`); ev.checks.push(false); } finally { ev.done(); }
