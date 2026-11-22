// P3-K1 / K2 / K4 / K5 on the cluster: the PVMBG mock changes schema, the Aggregator parks what it cannot map, Internal Ops replays after the mapper is adjusted.
//   usage: node scripts/cluster/drills/p3-schema-replay.mjs      env: MODE=rename (rename | type_change | drop_required)
// "Adjusting the system" = VOLCANIC_MAPPER_VERSION=v2 on the aggregator Deployment (rolling restart); v2 understands the rename and numeric-string shapes, not a dropped required field.
import { Evidence, audit, clientToken, expose, kubectl, sleep, timed, until } from './lib.mjs';

const MODE = process.env.MODE ?? 'rename';
const ev = new Evidence('P3/K4', 'cluster-p3-schema-replay', `P3-K1/K2/K4/K5: PVMBG mock mode "${MODE}" -> park -> adjust mapper -> replay`);
const aggregator = expose('aggregator', 8090), client = expose('client-api', 8080), auth = expose('auth-service', 8091), pv = expose('pvmbg-mock', 8082);
const A = audit(aggregator);
const post = (mode) => timed(`${pv}/admin/schema-version`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
const ops = async (role, path, init = {}) => timed(`${client}${path}`, { ...init, headers: { authorization: `Bearer ${await clientToken(auth, role)}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
try {
  await post('baseline');
  const bmkgBefore = (await A.checksum('BMKG')).count, pvmbgBefore = (await A.checksum('PVMBG')).count;
  const parkedBefore = ((await A.unprocessed('PVMBG'))?.items ?? []).length;
  ev.log(`baseline: PVMBG events=${pvmbgBefore}, parked PVMBG=${parkedBefore}, BMKG events=${bmkgBefore}`);
  ev.log(`schema change: ${(await post(MODE)).status}`);
  const items = await until('parked PVMBG records', async () => { const u = ((await A.unprocessed('PVMBG'))?.items ?? []); return u.length > parkedBefore ? u : null; }, 180_000, 3000).catch(() => []);
  ev.log(`parked after the change: ${items.length}; reasons: ${[...new Set(items.map((i) => i.reason))].slice(0, 3).join(' | ')}`);
  ev.check('K1/K2: incompatible records are parked with a reason, source and status (not stored, not guessed)', items.length > parkedBefore && items.every((i) => i.source === 'PVMBG' && !!i.reason && ['parked', 'retrying'].includes(i.status)));
  ev.check('K2: records parked as non-retryable are kept apart from retryable ones (field `retryable` present)', items.every((i) => typeof i.retryable === 'boolean'), `non-retryable ${items.filter((i) => !i.retryable).length}, retryable ${items.filter((i) => i.retryable).length}`);
  await sleep(15_000);
  const bmkgDuring = (await A.checksum('BMKG')).count;
  ev.check('K3: other sources keep flowing during the incident (BMKG count did not drop)', bmkgDuring >= bmkgBefore);
  const [m, l, i] = await Promise.all(['media', 'lapangan', 'internal'].map((r) => ops(r, '/ops/unprocessed')));
  ev.check(`K5: only Internal Ops can inspect (media ${m.status}, lapangan ${l.status}, internal ${i.status})`, m.status === 403 && l.status === 403 && i.status === 200);

  ev.log('adjusting the system: VOLCANIC_MAPPER_VERSION=v2 (rolling restart of the aggregator)');
  await post('baseline');
  kubectl(['set', 'env', 'deployment/aggregator', 'VOLCANIC_MAPPER_VERSION=v2']);
  kubectl(['rollout', 'status', 'deployment/aggregator', '--timeout=300s']);
  const stillParked = ((await A.unprocessed('PVMBG'))?.items ?? []).filter((x) => x.status === 'parked').length;
  const rep = await ops('internal', '/ops/replay', { method: 'POST', body: JSON.stringify({ source: 'PVMBG' }) });
  ev.log(`replay: HTTP ${rep.status} ${JSON.stringify(rep.body)}`);
  const left = ((await A.unprocessed('PVMBG'))?.items ?? []).length;
  const events = await A.allEvents('PVMBG');
  const ids = events.map((e) => e.source_ref_id);
  ev.check(`K4: replay recovered the parked records (parked ${stillParked} -> ${left}; the rest cannot be mapped by any mapper version)`, rep.status === 200 && left < stillParked || (MODE === 'drop_required' && left <= stillParked));
  ev.check('K4: no duplicate HazardEvent after the replay', new Set(ids).size === ids.length, `${ids.length} events`);
  const rep2 = await ops('internal', '/ops/replay', { method: 'POST', body: JSON.stringify({ source: 'PVMBG' }) });
  ev.check('K4: a second replay changes nothing', (await A.allEvents('PVMBG')).length === ids.length, JSON.stringify(rep2.body));
} finally { await post('baseline'); ev.done(); }
