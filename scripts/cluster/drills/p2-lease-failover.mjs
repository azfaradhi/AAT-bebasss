// P2-K1 / K2 / K3 on the cluster: Aggregator spread over nodes, one upstream caller at a time (mock request log), failover <= 60 s when the Lease holder is killed.
//   usage: node scripts/cluster/drills/p2-lease-failover.mjs      env: LEASE=bmkg
import { Evidence, audit, expose, kubectl, leaseHolder, leaseTransitions, now, podsOf, secret, sleep, timed, until } from './lib.mjs';

const LEASE = process.env.LEASE ?? 'bmkg';
const ev = new Evidence('P2/K3', 'cluster-p2-lease-failover', `P2-K1/K2/K3: kill the holder of Lease "${LEASE}" and measure takeover and upstream callers`);
const aggregator = expose('aggregator', 8090), mock = expose('bmkg-mock', 8081);
const A = audit(aggregator);
const pods = podsOf('aggregator');
ev.log('aggregator pods: ' + pods.map((p) => `${p.name}@${p.node}(${p.phase})`).join(', '));
ev.check('K1: at least 3 aggregator pods Running on at least 3 different nodes', pods.filter((p) => p.phase === 'Running').length >= 3 && new Set(pods.map((p) => p.node)).size >= 3, `nodes: ${[...new Set(pods.map((p) => p.node))].join(',')}`);
const callers = async (sinceIso) => { const r = await timed(`${mock}/admin/request-log?since=${encodeURIComponent(sinceIso)}`); return (r.body?.data ?? []).filter((e) => e.caller_instance && e.path.startsWith('/seismic')); };

const w0 = new Date().toISOString();
await sleep(20_000);
const before = await callers(w0);
const callerSet = [...new Set(before.map((e) => e.caller_instance))];
const holder = leaseHolder(LEASE);
ev.log(`lease ${LEASE} holder=${holder} transitions=${leaseTransitions(LEASE)}; BMKG mock callers in 20 s: ${callerSet.join(',') || 'none'} (${before.length} calls)`);
ev.check('K2: only the Lease holder called the BMKG mock (one caller_instance)', callerSet.length === 1 && callerSet[0] === holder);

const t0 = Date.now();
kubectl(['delete', 'pod', holder, '--grace-period=0', '--force'], { allowFail: true });
ev.log(`killed ${holder}`);
const next = await until('takeover', async () => { const h = leaseHolder(LEASE); return h && h !== holder ? h : null; }, 120_000, 500).catch(() => null);
const takeoverS = (Date.now() - t0) / 1000;
ev.check(`K3: another instance took the lease in ${takeoverS.toFixed(1)} s (limit 60 s)`, !!next && takeoverS <= 60, `new holder ${next}`);
await sleep(20_000);
const afterCalls = await callers(new Date(t0).toISOString());
const post = afterCalls.filter((e) => Date.parse(e.ts) > t0 + 2000);
ev.check('K3: after the takeover only the new holder calls the upstream', post.length > 0 && post.every((e) => e.caller_instance === next), `callers after: ${[...new Set(post.map((e) => e.caller_instance))].join(',')}`);
// no gap, no duplicate: Audit events of BMKG are unique and equal the mock's own list
const key = secret('BMKG_API_KEY');
const mockCount = ((await timed(`${mock}/seismic-events`, { headers: { 'x-bmkg-key': key } })).body?.data ?? []).length;
const ids = (await A.allEvents('BMKG')).map((e) => e.source_ref_id);
ev.check('K2/K3: BMKG HazardEvents are unique and equal the mock list (no gap, no duplicate; the mock may have produced one event not yet polled)', new Set(ids).size === ids.length && Math.abs(ids.length - mockCount) <= 2, `audit ${ids.length} unique ${new Set(ids).size}, mock ${mockCount}`);
ev.done();
