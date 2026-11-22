// P2-K4 on the cluster: the Tester Agent shifts a node clock; at every instant there must be exactly one Lease holder per source, and no duplicate HazardEvent.
//   usage: node scripts/cluster/drills/p2-clock-skew.mjs      env: SCENARIO=clock-skew  DURATION_S=180
import { Evidence, audit, expose, leaseHolder, leaseTransitions, runTester, secret, sleep, testerLogs, timed } from './lib.mjs';

const SCENARIO = process.env.SCENARIO ?? 'clock-skew';
const DURATION = Number(process.env.DURATION_S ?? 180);
const ev = new Evidence('P2/K4', 'cluster-p2-clock-skew', `P2-K4: Tester Agent scenario "${SCENARIO}"; Lease holders and upstream callers sampled every second`);
const aggregator = expose('aggregator', 8090), mock = expose('bmkg-mock', 8081);
const A = audit(aggregator);
const t0 = Date.now();
const before = { bmkg: leaseTransitions('bmkg'), pvmbg: leaseTransitions('pvmbg') };
ev.log(`leaseTransitions before: bmkg=${before.bmkg} pvmbg=${before.pvmbg}; holders bmkg=${leaseHolder('bmkg')} pvmbg=${leaseHolder('pvmbg')}`);
ev.log(runTester(SCENARIO).split('\n').slice(0, 5).join(' | '));
const holders = { bmkg: new Set(), pvmbg: new Set() };
let samples = 0;
while (Date.now() - t0 < DURATION * 1000) { for (const l of ['bmkg', 'pvmbg']) { const h = leaseHolder(l); if (h) holders[l].add(h); } samples++; await sleep(1000); }
const after = { bmkg: leaseTransitions('bmkg'), pvmbg: leaseTransitions('pvmbg') };
ev.log(`${samples} samples; holders seen: bmkg=${[...holders.bmkg].join(',')} pvmbg=${[...holders.pvmbg].join(',')}; leaseTransitions after: bmkg=${after.bmkg} pvmbg=${after.pvmbg}`);
const log = (await timed(`${mock}/admin/request-log?since=${encodeURIComponent(new Date(t0).toISOString())}`)).body?.data ?? [];
const perWindow = new Map();
for (const e of log.filter((x) => x.caller_instance && x.path.startsWith('/seismic'))) { const w = Math.floor(Date.parse(e.ts) / 5000); (perWindow.get(w) ?? perWindow.set(w, new Set()).get(w)).add(e.caller_instance); }
const doubled = [...perWindow.values()].filter((s) => s.size > 1).length;
ev.check('K4: never more than one upstream caller within any 5 s window', doubled === 0, `${perWindow.size} windows, ${doubled} with two callers`);
ev.check('K4: leadership did not flip-flop because of the clock shift (leaseTransitions rose by at most 1 per source)', after.bmkg - before.bmkg <= 1 && after.pvmbg - before.pvmbg <= 1, `bmkg +${after.bmkg - before.bmkg}, pvmbg +${after.pvmbg - before.pvmbg}`);
const ids = (await A.allEvents('BMKG')).map((e) => e.source_ref_id);
ev.check('K4: no duplicate HazardEvent', new Set(ids).size === ids.length, `${ids.length} events`);
ev.log('Tester Agent log (tail): ' + testerLogs().split('\n').slice(-6).join(' | '));
ev.done();
