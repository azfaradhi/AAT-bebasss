// P4-K5 / K8 on the cluster: kill the satellite-processor that holds the Lease; the other continues from the stored offset with no duplicate and no second feed connection.
//   usage: node scripts/cluster/drills/p4-satellite-leader.mjs      (scales satellite-processor to 2 first when it has 1 replica)
import { Evidence, audit, expose, kubectl, leaseHolder, leaseTransitions, podsOf, scale, secret, sleep, until } from './lib.mjs';

const ev = new Evidence('P4/K5', 'cluster-p4-satellite-leader', 'P4-K5/K8: delete the Lease holder of the satellite stream, watch SATELIT events continue without duplicates');
const A = audit(expose('aggregator', 8090));
if (podsOf('satellite-processor').length < 2) { scale('satellite-processor', 2); await until('2 replicas ready', async () => podsOf('satellite-processor').filter((p) => p.phase === 'Running').length >= 2, 180_000, 3000); }
ev.log('satellite-processor pods: ' + podsOf('satellite-processor').map((p) => `${p.name}@${p.node}`).join(', '));
const holder = await until('satellite lease', async () => leaseHolder('satellite'), 60_000);
const count = async () => (await A.checksum('SATELIT')).count;
const c0 = await count(); await sleep(20_000); const c1 = await count();
ev.log(`holder ${holder}, transitions ${leaseTransitions('satellite')}; SATELIT events ${c0} -> ${c1} in 20 s`);
const t0 = Date.now();
kubectl(['delete', 'pod', holder, '--grace-period=0', '--force'], { allowFail: true });
const next = await until('takeover', async () => { const h = leaseHolder('satellite'); return h && h !== holder ? h : null; }, 180_000, 500).catch(() => null);
const secs = (Date.now() - t0) / 1000;
ev.check(`another instance holds the satellite lease after ${secs.toFixed(1)} s (limit 60 s)`, !!next && secs <= 60, `new holder ${next}`);
await sleep(60_000);
const c2 = await count();
ev.check('SATELIT events kept arriving after the takeover (stream resumed from the stored offset)', c2 >= c1, `${c1} -> ${c2}`);
const events = await A.allEvents('SATELIT');
const ids = events.map((e) => e.source_ref_id);
ev.check('no duplicate fire (unique source_ref_id) and stable ids', new Set(ids).size === ids.length, `${ids.length} events`);
const standby = podsOf('satellite-processor').find((p) => p.name !== next);
const logs = standby ? kubectl(['logs', standby.name, '--tail=300'], { allowFail: true }) : '';
ev.check('the standby never got HTTP 429 from the feed (never opened a second connection)', !/429|too_many_connections/i.test(logs));
ev.done();
