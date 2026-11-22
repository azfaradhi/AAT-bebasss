// P1-K4 / K5 / K6 on the cluster: a worker node is killed and its data wiped (Tester Agent), while a continuous reader and writer run through the real entry points.
// Pass conditions: BMKG/PVMBG checksums equal the baseline (no HazardEvent lost), no request answered 500 or left hanging, every 202'd field report is processed,
// the ring returns to STABLE with redundancy_ok, and (SECOND=1) a second node loss after that is survived too.
//   usage: node scripts/cluster/drills/p1-node-loss.mjs            env: SCENARIO=wipe-node  MAX_WAIT_MIN=40  SECOND=1  FREEZE=1
// wipe-node powers the VM off: start it again by hand (VBoxManage startvm <vm> --type headless); the drill keeps polling until the node is back.
import { Evidence, audit, clientToken, expose, freezeSources, p95, runTester, secret, sleep, testerLogs, timed, until } from './lib.mjs';

const SCENARIO = process.env.SCENARIO ?? 'wipe-node';
const MAX_WAIT_MIN = Number(process.env.MAX_WAIT_MIN ?? 40);
const ev = new Evidence('P1/K4', 'cluster-p1-node-loss', `P1-K4/K5/K6: Tester Agent scenario "${SCENARIO}" with continuous reader+writer; checksums via Audit API`);
const aggregator = expose('aggregator', 8090), client = expose('client-api', 8080), auth = expose('auth-service', 8091);
const A = audit(aggregator);
const restore = process.env.FREEZE === '0' ? () => {} : freezeSources(ev);
try {
  const base = { BMKG: await A.checksum('BMKG'), PVMBG: await A.checksum('PVMBG') };
  ev.log(`baseline BMKG count=${base.BMKG.count} sha=${base.BMKG.checksum?.slice(0, 16)} partial=${base.BMKG.partial}; PVMBG count=${base.PVMBG.count} sha=${base.PVMBG.checksum?.slice(0, 16)} partial=${base.PVMBG.partial}`);
  const pl = await A.placement().catch(() => null);
  if (pl) { ev.log(`placement (primary/replica/held per node): ${pl.units.map((u) => `${u.node}:${u.primary_keys}/${u.replica_keys}/${u.keys_held}`).join('  ')} replicas_on_distinct_nodes=${pl.replicas_on_distinct_nodes}`); ev.check('before the loss every unit has its replica on a different node from its primary', pl.replicas_on_distinct_nodes === true); }
  const tokInternal = await clientToken(auth, 'internal'), tokField = await clientToken(auth, 'lapangan'), auditToken = secret('AUDIT_TOKEN');

  // continuous reader + writer
  const stats = { reads: 0, readBad: [], readMs: [], partial: 0, writes: 0, writeBad: [], accepted: [], writeMs: [], hanging: 0 };
  let stop = false, n = 0;
  const reader = (async () => { while (!stop) { const r = await timed(`${aggregator}/internal/audit/events?limit=1`, { headers: { authorization: `Bearer ${auditToken}` } }, 8000); stats.reads++; stats.readMs.push(r.ms); if (r.status === 0) stats.hanging++; if (r.status !== 200) stats.readBad.push(r.status); else if (r.body?.partial) stats.partial++; await sleep(1000); } })();
  const reader2 = (async () => { while (!stop) { const r = await timed(`${client}/api/v1/hazards?limit=50`, { headers: { authorization: `Bearer ${tokInternal}` } }, 8000); stats.reads++; stats.readMs.push(r.ms); if (r.status === 0) stats.hanging++; if (r.status >= 500 || r.status === 0) stats.readBad.push(r.status); await sleep(1000); } })();
  const writer = (async () => { while (!stop) { const key = `drill-${Date.now()}-${n++}`; const r = await timed(`${client}/field-reports`, { method: 'POST', headers: { authorization: `Bearer ${tokField}`, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ category: 'KERUSAKAN', description: `drill ${key}`, latitude: -6.2, longitude: 106.8, observed_at: new Date().toISOString() }) }, 8000); stats.writes++; stats.writeMs.push(r.ms); if (r.status === 202) stats.accepted.push(key); else stats.writeBad.push(r.status); await sleep(2000); } })();

  ev.log(`running Tester Agent practice scenario "${SCENARIO}"`);
  ev.log(runTester(SCENARIO).split('\n').slice(0, 6).join(' | '));
  const t0 = Date.now();
  let lastLine = '';
  const recovered = await until('ring recovered', async () => {
    const r = await A.ring(); if (!r) return null;
    const line = r.units.map((u) => `${u.node}:${u.state}/${u.keys}`).join(' ');
    if (line !== lastLine) { ev.log(`t+${Math.round((Date.now() - t0) / 1000)}s ring ${line} redundancy_ok=${r.redundancy_ok}`); lastLine = line; }
    return r.units.every((u) => u.state === 'STABLE') && r.redundancy_ok && Date.now() - t0 > 20_000 ? r : null;
  }, MAX_WAIT_MIN * 60_000, 5000).catch((e) => { ev.log(String(e)); return null; });
  const seconds = Math.round((Date.now() - t0) / 1000);
  await sleep(10_000);
  stop = true; await Promise.all([reader, reader2, writer]);

  ev.log(`reads ${stats.reads} (p95 ${p95(stats.readMs).toFixed(0)} ms, ${stats.partial} partial answers, ${stats.hanging} hanging); writes ${stats.writes} (202: ${stats.accepted.length}, other: ${stats.writeBad.join(',') || 'none'}, p95 ${p95(stats.writeMs).toFixed(0)} ms)`);
  ev.check(`ring back to all STABLE with redundancy_ok after ${seconds} s`, !!recovered);
  ev.check('no request answered 5xx or left hanging during the loss and recovery', stats.readBad.length === 0 && stats.hanging === 0, `bad: ${stats.readBad.join(',') || 'none'}`);
  const after = { BMKG: await A.checksum('BMKG'), PVMBG: await A.checksum('PVMBG') };
  for (const s of ['BMKG', 'PVMBG']) ev.check(`${s}: count and sha256 equal the baseline (no HazardEvent lost) and not partial`, after[s].count === base[s].count && after[s].checksum === base[s].checksum && after[s].partial === false, `${after[s].count} vs ${base[s].count}`);
  const fr = await A.fieldReports();
  const processedAll = await until('field reports processed', async () => { const f = await A.fieldReports(); return f.processed_total >= f.accepted_total ? f : null; }, 120_000, 3000).catch(() => null);
  ev.check(`every 202 field report written during the drill is processed (accepted ${fr?.accepted_total}, processed ${processedAll?.processed_total})`, !!processedAll);
  const pl2 = await A.placement().catch(() => null);
  if (pl2) ev.log(`placement after recovery: ${pl2.units.map((u) => `${u.node}:${u.primary_keys}/${u.replica_keys}/${u.keys_held}`).join('  ')}`);

  if (process.env.SECOND === '1' && recovered) {
    ev.log('K6: second loss after recovery (kill-store)');
    ev.log(runTester('kill-store').split('\n').slice(0, 4).join(' | '));
    await sleep(60_000);
    const again = { BMKG: await A.checksum('BMKG'), PVMBG: await A.checksum('PVMBG') };
    for (const s of ['BMKG', 'PVMBG']) ev.check(`K6 ${s}: still complete after a second loss`, again[s].count === base[s].count && again[s].checksum === base[s].checksum);
  }
  ev.log('Tester Agent log (tail): ' + testerLogs().split('\n').slice(-6).join(' | '));
} finally { restore(); ev.done(); }
