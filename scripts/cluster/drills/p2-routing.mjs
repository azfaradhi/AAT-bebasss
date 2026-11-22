// P2-K1 on the cluster: the single entry point stops routing to an unhealthy/terminating Aggregator instance (no failed request while one pod is deleted).
//   usage: node scripts/cluster/drills/p2-routing.mjs      env: RPS=20 DURATION_S=60
import { Evidence, expose, kubectl, podsOf, sleep, timed } from './lib.mjs';

const RPS = Number(process.env.RPS ?? 20), DURATION = Number(process.env.DURATION_S ?? 60);
const ev = new Evidence('P2/K1', 'cluster-p2-routing', `P2-K1: ${RPS} req/s to the aggregator Service for ${DURATION} s while one pod is deleted`);
const url = `${expose('aggregator', 8090)}/health`;
const pods = podsOf('aggregator');
ev.log('pods: ' + pods.map((p) => `${p.name}@${p.node}`).join(', '));
const bad = []; let total = 0, stop = false;
const hit = async () => { const r = await timed(url, {}, 4000); total++; if (r.status !== 200) bad.push(`${r.status}@${new Date().toISOString().slice(14, 23)}`); };
const loop = (async () => { while (!stop) { const t = Date.now(); for (let i = 0; i < RPS; i++) void hit(); await sleep(Math.max(0, 1000 - (Date.now() - t))); } })();
await sleep(15_000);
const victim = pods[0].name;
ev.log(`deleting ${victim} (graceful) at t+15 s`);
kubectl(['delete', 'pod', victim, '--wait=false']);
await sleep((DURATION - 15) * 1000);
stop = true; await loop; await sleep(5000);
ev.log(`requests ${total}, not 200: ${bad.length} ${bad.slice(0, 10).join(' ')}`);
ev.check('no request failed while an instance was removed (the Service stopped routing to it)', bad.length === 0);
ev.done();
